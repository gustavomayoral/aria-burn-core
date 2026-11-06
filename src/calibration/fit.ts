// SPDX-License-Identifier: MIT
// Material fit from a photographed test grid (BURN-15). Given each cell's
// colour as photographed (Lab, after card correction) and the simulator's
// forward fields for the same job (forward.ts), fit the response parameters of
// the material's kind. The schema is unchanged: every fitted value is an
// existing MaterialProfile field (COD-250 threshold-based design).
//
//   char    baseColor, charColor, toneStart, toneEnd, toneGamma, and with a
//           peakTemperature model rampOnsetK (the COD-258 thermal correction:
//           how much preheat counts, via the dose's bulk term). From optional
//           manual depths: ablationThreshold, depthMmPerJPerMm2. From cells the
//           user saw flame: fireRisk.thresholdK.
//   melt    baseColor, frostColor, frostStart, frostFull (rampOnsetK with a
//           thermal model); from depths: removalThreshold, depthMmPerJPerMm2.
//   bleach  baseColor, markColor, markStart, markFull (the saturation point).
//   option  the S → power curve's shape at the grid's power steps (relative to
//           full power, which stays the module's rated power): a machine
//           reading, returned apart from the material.
//
// Not fitted, kept from the starting profile: absorption, sigmaHeatMm and the
// thermal constants (absorbed energy scales every threshold together, so
// absorption and the thresholds can't be told apart from colour alone), the
// absorption feedback level, bleach's damage threshold.
//
// Colour residuals are Lab differences per cell (CIE76 components, so the
// solver sees a smooth cost); the report uses CIEDE2000.

import { interpolateCurve, type Lab, type MachineProfile, type MaterialProfile, type PowerCurvePoint } from '../contract/index.ts'
import type { SampleStore } from '../sim/sample-store.ts'
import { deltaE2000, deltaE76, labToLinear, linearToLab } from './color.ts'
import { cellFields, type CellField, type CellFields, type ForwardOptions } from './forward.ts'
import { levenbergMarquardt } from './solve.ts'
import type { PatternCell } from './types.ts'

export interface CellObservation {
  id: string
  lab: Lab
  /** Residual weight, default 1. */
  weight?: number
}

/** A depth the user measured on a burned cell (mm, the typical depth over the middle of the cell). */
export interface DepthEntry {
  cellId: string
  depthMm: number
}

export interface FitInput {
  cells: readonly PatternCell[]
  /** Samples of the pattern job (actual motion: the app's planner, or the core sampler). */
  store: SampleStore
  machine: MachineProfile
  /** Starting profile: its kind, physics and initial guesses. */
  material: MaterialProfile
  observations: readonly CellObservation[]
  /** Bare material colour from the photo; used as a zero-dose cell. */
  base?: Lab
  /** Optional manual depth readings (2–3 cells). */
  depths?: readonly DepthEntry[] | undefined
  /** Cells where the user saw flame or flare-ups (fire-risk threshold). Undefined: not asked. */
  fireCellIds?: readonly string[] | undefined
  /** Fit the S → power curve's shape from the grid's power steps. Default false. */
  fitPowerCurve?: boolean | undefined
  forward?: ForwardOptions
  /** Thermal reruns for absorption feedback. Default 3. */
  maxThermalIterations?: number
  /** Fitted profile identity. */
  id?: string
  name?: string
  /** ISO timestamp for provenance (default now). */
  fittedAt?: string
}

export interface ParameterReport {
  name: string
  value: number
  unit: string
  /** One-sigma uncertainty from the fit's covariance, null when not available. */
  sigma: number | null
  /** False when the grid barely constrains it (the weak prior dominates). */
  constrained: boolean
}

export interface CellComparison {
  id: string
  observed: Lab
  predicted: Lab
  deltaE: number
}

export interface DepthFit {
  thresholdJPerMm2: number
  depthMmPerJPerMm2: number
  /** Per entry: measured vs predicted (mm). */
  entries: { cellId: string; measuredMm: number; predictedMm: number }[]
  note: string
}

export interface FireFit {
  thresholdK: number
  /** The threshold lies in [lowerK, upperK] given the flags (upper Infinity when no cell flamed). */
  lowerK: number
  upperK: number
  source: 'flags' | 'lower-bound' | 'kept'
  note: string
}

export interface FitResult {
  material: MaterialProfile
  /** Proposed S → power curve (a machine reading, not applied), when fitPowerCurve. */
  powerCurve: PowerCurvePoint[] | null
  /**
   * Per-step factor on the nominal curve, keyed by S fraction, relative to the
   * anchor step (factor 1). `constrained` is false for steps whose cells were
   * all unmarked or all fully marked.
   */
  powerFactors: { sFraction: number; factor: number; constrained: boolean; anchor: boolean }[] | null
  cells: CellComparison[]
  meanDeltaE: number
  maxDeltaE: number
  parameters: ParameterReport[]
  depth: DepthFit | null
  fire: FireFit | null
  thermalIterations: number
  notes: string[]
}

/** The response as the fit sees it: a colour lerp a → b over [start, end]^gamma on dose. */
interface Working {
  base: Lab
  top: Lab
  start: number
  end: number
  gamma: number
  /** rampOnsetK − ambientK, null without a thermal model. */
  onsetRise: number | null
  /** Power factor per S fraction (fitted steps only). */
  power: Map<number, number>
}

const BINS = 256
/**
 * Assumed per-component photo noise (ΔE units) for the reported σ: the covariance uses
 * max(this², residual variance), so a near-perfect synthetic fit still reports how
 * well the grid pins each parameter down.
 */
export const OBS_NOISE_DE = 0.5

function working(material: MaterialProfile): Working {
  const r = material.response
  const t = material.thermal.kind === 'peakTemperature' ? material.thermal : null
  const onsetRise = t ? t.rampOnsetK - t.ambientK : null
  switch (r.kind) {
    case 'char':
      return { base: r.baseColor, top: r.charColor, start: r.toneStartJPerMm2, end: r.toneEndJPerMm2, gamma: r.toneGamma, onsetRise, power: new Map() }
    case 'melt':
      return { base: r.baseColor, top: r.frostColor, start: r.frostStartJPerMm2, end: r.frostFullJPerMm2, gamma: 1, onsetRise, power: new Map() }
    case 'bleach':
      return { base: r.baseColor, top: r.markColor, start: r.markStartJPerMm2, end: r.markFullJPerMm2, gamma: 1, onsetRise, power: new Map() }
  }
}

/** Dose at a field point under w. */
const doseOf = (w: Working, flashK: number | null, m: number, flash: number, bulk: number) =>
  m * (flashK === null ? flash : flash + bulk / flashK)

function rampAt(w: Working, d: number): number {
  const span = w.end - w.start
  const t = span > 0 ? (d - w.start) / span : d >= w.start ? 1 : 0
  const c = Math.min(1, Math.max(0, t))
  return w.gamma === 1 ? c : c ** w.gamma
}

/** Predicted Lab of a cell: mean linear RGB over its field points, via a histogram of the ramp position. */
function predictCell(w: Working, field: CellField, hist: Float64Array, lut: [number, number, number][]): Lab {
  const flashK = w.onsetRise === null ? null : w.onsetRise / Math.max(w.start, 1e-9)
  const m = w.power.get(field.sFraction) ?? 1
  hist.fill(0)
  const n = field.flash.length
  for (let i = 0; i < n; i++) {
    const t = rampAt(w, doseOf(w, flashK, m, field.flash[i]!, field.bulk[i]!)) * (BINS - 1)
    const k = Math.min(BINS - 2, Math.floor(t))
    const f = t - k
    hist[k]! += 1 - f
    hist[k + 1]! += f
  }
  let r = 0
  let g = 0
  let b = 0
  for (let k = 0; k < BINS; k++) {
    const h = hist[k]!
    if (!h) continue
    r += h * lut[k]![0]
    g += h * lut[k]![1]
    b += h * lut[k]![2]
  }
  return linearToLab([r / n, g / n, b / n])
}

function colourLut(w: Working): [number, number, number][] {
  const lut: [number, number, number][] = []
  for (let k = 0; k < BINS; k++) {
    const t = k / (BINS - 1)
    lut.push(labToLinear({ l: w.base.l + (w.top.l - w.base.l) * t, a: w.base.a + (w.top.a - w.base.a) * t, b: w.base.b + (w.top.b - w.base.b) * t }))
  }
  return lut
}

interface ParamSpec {
  name: string
  unit: string
  get(w: Working): number
  set(w: Working, v: number): void
  /** Vector value ↔ parameter value. */
  toVec(v: number): number
  fromVec(x: number): number
  /** Weak prior width in vector units. */
  priorSigma: number
  /** Vector is the log of the value. */
  log: boolean
}

const raw = (name: string, unit: string, get: (w: Working) => number, set: (w: Working, v: number) => void, priorSigma: number): ParamSpec => ({
  name,
  unit,
  get,
  set,
  toVec: (v) => v,
  fromVec: (x) => x,
  priorSigma,
  log: false,
})
const logp = (name: string, unit: string, get: (w: Working) => number, set: (w: Working, v: number) => void, priorSigma = 2): ParamSpec => ({
  name,
  unit,
  get,
  set,
  toVec: (v) => Math.log(Math.max(v, 1e-12)),
  fromVec: (x) => Math.exp(x),
  priorSigma,
  log: true,
})

function paramSpecs(material: MaterialProfile, powerSteps: number[]): ParamSpec[] {
  const kind = material.response.kind
  const top = kind === 'char' ? 'charColor' : kind === 'melt' ? 'frostColor' : 'markColor'
  const [s0, s1] = kind === 'char' ? ['toneStart', 'toneEnd'] : kind === 'melt' ? ['frostStart', 'frostFull'] : ['markStart', 'markFull']
  const lab = (which: 'base' | 'top', label: string): ParamSpec[] =>
    (['l', 'a', 'b'] as const).map((c) =>
      raw(`${label}.${c}`, c === 'l' ? 'L*' : `${c}*`, (w) => w[which][c], (w, v) => (w[which] = { ...w[which], [c]: v }), 40),
    )
  const specs: ParamSpec[] = [
    ...lab('base', 'baseColor'),
    ...lab('top', top),
    logp(`${s0}JPerMm2`, 'J/mm²', (w) => w.start, (w, v) => {
      const span = w.end - w.start
      w.start = v
      w.end = v + span
    }),
    logp(`${s1}JPerMm2 − ${s0}`, 'J/mm²', (w) => w.end - w.start, (w, v) => (w.end = w.start + v)),
  ]
  if (kind === 'char') specs.push(logp('toneGamma', '', (w) => w.gamma, (w, v) => (w.gamma = v), 1))
  if (material.thermal.kind === 'peakTemperature')
    specs.push(logp('rampOnsetK − ambientK', 'K', (w) => w.onsetRise!, (w, v) => (w.onsetRise = v), 1))
  for (const s of powerSteps)
    specs.push(logp(`power factor @ S ${(s * 100).toFixed(1)} %`, '×', (w) => w.power.get(s) ?? 1, (w, v) => w.power.set(s, v), 1))
  return specs
}

const cloneW = (w: Working): Working => ({ ...w, base: { ...w.base }, top: { ...w.top }, power: new Map(w.power) })

/** Writes a fitted working state back into a profile of the same kind. */
function applyWorking(material: MaterialProfile, w: Working): MaterialProfile {
  const m: MaterialProfile = structuredClone(material)
  const r = m.response
  const round = (v: number, d = 4) => Number(v.toPrecision(d))
  const lab = (c: Lab): Lab => ({ l: Math.min(100, Math.max(0, round(c.l, 4))), a: round(c.a, 4), b: round(c.b, 4) })
  switch (r.kind) {
    case 'char':
      r.baseColor = lab(w.base)
      r.charColor = lab(w.top)
      r.toneStartJPerMm2 = round(w.start)
      r.toneEndJPerMm2 = round(w.end)
      r.toneGamma = round(w.gamma)
      r.ablationThresholdJPerMm2 = Math.max(r.ablationThresholdJPerMm2, r.toneStartJPerMm2)
      break
    case 'melt':
      r.baseColor = lab(w.base)
      r.frostColor = lab(w.top)
      r.frostStartJPerMm2 = round(w.start)
      r.frostFullJPerMm2 = round(w.end)
      r.removalThresholdJPerMm2 = Math.max(r.removalThresholdJPerMm2, r.frostFullJPerMm2)
      break
    case 'bleach':
      r.baseColor = lab(w.base)
      r.markColor = lab(w.top)
      r.markStartJPerMm2 = round(w.start)
      r.markFullJPerMm2 = round(w.end)
      r.damageThresholdJPerMm2 = Math.max(r.damageThresholdJPerMm2, r.markFullJPerMm2)
      break
  }
  if (m.thermal.kind === 'peakTemperature' && w.onsetRise !== null) m.thermal.rampOnsetK = round(m.thermal.ambientK + w.onsetRise, 5)
  return m
}

/**
 * Power steps whose factor is fitted, and the anchor step whose nominal power
 * is taken as right. Power and the material's sensitivity trade off (scaling
 * every step's power and every threshold together changes nothing on the
 * photo), so one step must be fixed, and it must be one whose cells sit inside
 * the ramp: a step whose cells are all unmarked or all fully marked fixes
 * nothing. The anchor is S max when at least two of its cells are mid-ramp,
 * else the step with the most mid-ramp cells.
 */
function powerSteps(fields: CellFields, observations: readonly CellObservation[], base: Lab): { anchor: number; steps: number[]; midCells: Map<number, number> } {
  const all = [...new Set(fields.cells.map((c) => c.sFraction))].sort((a, b) => a - b)
  const sOf = new Map(fields.cells.map((c) => [c.id, c.sFraction]))
  const d = observations.filter((o) => sOf.has(o.id)).map((o) => ({ s: sOf.get(o.id)!, d: deltaE76(o.lab, base) }))
  const dMax = Math.max(...d.map((x) => x.d), 1e-9)
  const midCells = new Map(all.map((s) => [s, d.filter((x) => x.s === s && x.d > 0.1 * dMax && x.d < 0.9 * dMax).length]))
  const top = all[all.length - 1]!
  let anchor = top
  if ((midCells.get(top) ?? 0) < 2) for (const s of all) if (midCells.get(s)! > midCells.get(anchor)!) anchor = s
  return { anchor, steps: all.filter((s) => s !== anchor), midCells }
}

interface ColourFit {
  w: Working
  cells: CellComparison[]
  parameters: ParameterReport[]
}

function fitColours(fields: CellFields, input: FitInput, w0: Working, specs: ParamSpec[], prior: Working): ColourFit {
  const byId = new Map(fields.cells.map((c) => [c.id, c]))
  const obs = input.observations.filter((o) => byId.has(o.id))
  if (obs.length < 4) throw new Error(`fit needs at least 4 observed cells, got ${obs.length}`)
  const hist = new Float64Array(BINS)
  const p0 = Float64Array.from(specs.map((s) => s.toVec(s.get(w0))))
  const pPrior = specs.map((s) => s.toVec(s.get(prior)))
  const unpack = (p: Float64Array): Working => {
    const w = cloneW(w0)
    specs.forEach((s, i) => s.set(w, s.fromVec(p[i]!)))
    return w
  }
  const residuals = (p: Float64Array): Float64Array => {
    const w = unpack(p)
    const lut = colourLut(w)
    const out: number[] = []
    for (const o of obs) {
      const pr = predictCell(w, byId.get(o.id)!, hist, lut)
      const k = o.weight ?? 1
      out.push(k * (pr.l - o.lab.l), k * (pr.a - o.lab.a), k * (pr.b - o.lab.b))
    }
    if (input.base) out.push(w.base.l - input.base.l, w.base.a - input.base.a, w.base.b - input.base.b)
    specs.forEach((s, i) => out.push((p[i]! - pPrior[i]!) / s.priorSigma))
    return Float64Array.from(out)
  }
  const lm = levenbergMarquardt(residuals, p0, { maxIterations: 200, noiseVariance: OBS_NOISE_DE ** 2 })
  const w = unpack(lm.p)
  const lut = colourLut(w)
  const cells = obs.map((o) => {
    const predicted = predictCell(w, byId.get(o.id)!, hist, lut)
    return { id: o.id, observed: o.lab, predicted, deltaE: deltaE2000(o.lab, predicted) }
  })
  const n = specs.length
  const parameters = specs.map((s, i) => {
    const v = lm.covariance ? lm.covariance[i * n + i]! : NaN
    const sx = Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : null
    // Back to parameter units: log parameters carry a relative σ.
    const value = s.fromVec(lm.p[i]!)
    const sigma = sx === null ? null : s.log ? value * sx : sx
    return { name: s.name, value, unit: s.unit, sigma, constrained: sx !== null && sx < 0.5 * s.priorSigma }
  })
  return { w, cells, parameters }
}

/** Mean depth over a cell's field points under dose → k · max(0, D − thr). */
function cellDepth(w: Working, field: CellField, thr: number, k: number): number {
  const flashK = w.onsetRise === null ? null : w.onsetRise / Math.max(w.start, 1e-9)
  const m = w.power.get(field.sFraction) ?? 1
  let s = 0
  for (let i = 0; i < field.flash.length; i++) s += Math.max(0, doseOf(w, flashK, m, field.flash[i]!, field.bulk[i]!) - thr)
  return (k * s) / field.flash.length
}

function fitDepth(w: Working, fields: CellFields, entries: readonly DepthEntry[], kept: { thr: number; k: number }, minThr: number): DepthFit | null {
  const byId = new Map(fields.cells.map((c) => [c.id, c]))
  const use = entries.filter((e) => byId.has(e.cellId) && Number.isFinite(e.depthMm) && e.depthMm >= 0)
  if (use.length === 0) return null
  const positive = use.filter((e) => e.depthMm > 0).length
  const flashK = w.onsetRise === null ? null : w.onsetRise / Math.max(w.start, 1e-9)
  let dMax = 0
  for (const e of use) {
    const f = byId.get(e.cellId)!
    const m = w.power.get(f.sFraction) ?? 1
    for (let i = 0; i < f.flash.length; i++) dMax = Math.max(dMax, doseOf(w, flashK, m, f.flash[i]!, f.bulk[i]!))
  }
  // For a threshold, the best k is closed-form; scan thresholds, then refine.
  const evalThr = (thr: number): { k: number; sse: number } => {
    const unit = use.map((e) => cellDepth(w, byId.get(e.cellId)!, thr, 1))
    const num = use.reduce((s, e, i) => s + e.depthMm * unit[i]!, 0)
    const den = unit.reduce((s, u) => s + u * u, 0)
    const k = positive >= 2 ? (den > 0 ? num / den : 0) : kept.k
    const sse = use.reduce((s, e, i) => s + (k * unit[i]! - e.depthMm) ** 2, 0)
    return { k, sse }
  }
  let note: string
  let thr: number
  if (positive === 0) {
    // Only an upper bound on the dose that removes nothing: the threshold is at least the deepest dose seen.
    thr = Math.max(kept.thr, dMax, minThr)
    note = 'No cell had measurable depth: the threshold is at least the highest dose of the measured cells.'
    return { thresholdJPerMm2: thr, depthMmPerJPerMm2: kept.k, entries: use.map((e) => ({ cellId: e.cellId, measuredMm: e.depthMm, predictedMm: cellDepth(w, byId.get(e.cellId)!, thr, kept.k) })), note }
  }
  let best = { thr: minThr, k: 0, sse: Infinity }
  const lo = minThr
  const hi = Math.max(dMax, lo * 1.0001)
  for (let i = 0; i <= 200; i++) {
    const t = lo + ((hi - lo) * i) / 200
    const r = evalThr(t)
    if (r.sse < best.sse) best = { thr: t, ...r }
  }
  // Golden-section refine around the best scan point.
  let a = Math.max(lo, best.thr - (hi - lo) / 200)
  let b = Math.min(hi, best.thr + (hi - lo) / 200)
  for (let i = 0; i < 40; i++) {
    const c = b - (b - a) * 0.618
    const d = a + (b - a) * 0.618
    if (evalThr(c).sse < evalThr(d).sse) b = d
    else a = c
  }
  thr = (a + b) / 2
  const k = evalThr(thr).k
  note = positive >= 2 ? `Fitted from ${positive} cells with depth.` : 'Only one cell had depth: the depth scale is kept from the starting profile, the threshold is fitted.'
  return { thresholdJPerMm2: thr, depthMmPerJPerMm2: k, entries: use.map((e) => ({ cellId: e.cellId, measuredMm: e.depthMm, predictedMm: cellDepth(w, byId.get(e.cellId)!, thr, k) })), note }
}

function fitFire(w: Working, fields: CellFields, flagged: readonly string[], keptK: number | null): FireFit | null {
  if (!fields.thermal) return null
  const amb = fields.thermal.ambientK
  const set = new Set(flagged)
  // Bulk temperature scales with power, so the power factor applies to the rise.
  const bulk = fields.cells.map((c) => ({ id: c.id, k: amb + (c.bulkMaxK - amb) * (w.power.get(c.sFraction) ?? 1), fire: set.has(c.id) }))
  const calm = bulk.filter((c) => !c.fire)
  const fire = bulk.filter((c) => c.fire)
  const lowerK = calm.length ? Math.max(...calm.map((c) => c.k)) : amb
  if (fire.length === 0) {
    if (keptK !== null && keptK > lowerK)
      return { thresholdK: keptK, lowerK, upperK: Infinity, source: 'kept', note: 'No cell flamed; the starting threshold is above every cell, so it is kept.' }
    const t = Math.ceil(lowerK + 1)
    return { thresholdK: t, lowerK, upperK: Infinity, source: 'lower-bound', note: 'No cell flamed but cells got hotter than the starting threshold: raised to just above the hottest cell (a lower bound).' }
  }
  // Threshold with the fewest misclassified cells; ties → middle of the gap.
  const temps = [...new Set(bulk.map((c) => c.k))].sort((a, b) => a - b)
  let best = { t: temps[0]!, errors: Infinity, lo: amb, hi: temps[0]! }
  for (let i = 0; i < temps.length; i++) {
    const hi = temps[i]!
    const lo = i > 0 ? temps[i - 1]! : amb
    const t = (lo + hi) / 2
    const errors = bulk.filter((c) => (c.k >= hi) !== c.fire).length
    if (errors < best.errors) best = { t, errors, lo, hi }
  }
  return {
    thresholdK: Math.round(best.t),
    lowerK: best.lo,
    upperK: best.hi,
    source: 'flags',
    note: best.errors ? `${best.errors} flagged cell(s) disagree with any single threshold; this one misclassifies the fewest.` : 'Between the hottest calm cell and the coolest cell that flamed.',
  }
}

function proposePowerCurve(machine: MachineProfile, factors: { sFraction: number; factor: number; constrained: boolean }[]): PowerCurvePoint[] {
  const used = factors.filter((f) => f.constrained && f.sFraction < 1)
  const pts: PowerCurvePoint[] = []
  const lowest = used[0]
  // Below the lowest fitted step the nominal shape is kept, scaled to meet it; above the highest, nominal.
  for (const p of machine.powerCurve) if (lowest && p.s < lowest.sFraction) pts.push({ s: p.s, power: p.power * lowest.factor })
  for (const f of used) pts.push({ s: f.sFraction, power: interpolateCurve(machine.powerCurve, f.sFraction) * f.factor })
  const highest = used[used.length - 1]
  for (const p of machine.powerCurve) if (!highest || p.s > highest.sFraction) pts.push({ s: p.s, power: p.power })
  let run = 0
  return pts.map((p) => {
    run = Math.min(1, Math.max(run, p.power))
    return { s: Number(p.s.toFixed(4)), power: Number(run.toFixed(4)) }
  })
}

/**
 * Fit a material to a photographed grid. Runs the forward model (one thermal
 * run, more with absorption feedback), the colour fit, then depth and fire.
 */
export function fitMaterial(input: FitInput): FitResult {
  const notes: string[] = []
  const start = input.material
  const feedback = start.response.kind === 'char' && start.thermal.kind === 'peakTemperature' && start.thermal.absorptionAtFullChar !== undefined
  const maxIt = feedback ? Math.max(1, input.maxThermalIterations ?? 3) : 1
  let material = start
  let fields = cellFields(input.store, input.machine, material, input.cells, input.forward)
  const power = input.fitPowerCurve ? powerSteps(fields, input.observations, input.base ?? working(start).base) : null
  const steps = power?.steps ?? []
  const specs = paramSpecs(start, steps)
  const prior = working(start)
  let w0 = working(start)
  if (input.base) w0.base = { ...input.base }
  let fit = fitColours(fields, input, w0, specs, prior)
  let iterations = 1
  for (; iterations < maxIt; iterations++) {
    const prev = fit.w
    material = applyWorking(start, prev)
    fields = cellFields(input.store, input.machine, material, input.cells, input.forward)
    fit = fitColours(fields, input, prev, specs, prior)
    const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12)
    const change = Math.max(rel(fit.w.start, prev.start), rel(fit.w.end, prev.end), prev.onsetRise ? rel(fit.w.onsetRise!, prev.onsetRise) : 0)
    if (change < 0.005) {
      iterations++
      break
    }
  }
  if (feedback) notes.push(`Absorption feedback: ${iterations} thermal run(s) to converge.`)
  let fitted = applyWorking(start, fit.w)
  // Depth
  let depth: DepthFit | null = null
  if (input.depths?.length && fitted.response.kind !== 'bleach') {
    const r = fitted.response
    const kept = r.kind === 'char' ? { thr: r.ablationThresholdJPerMm2, k: r.depthMmPerJPerMm2 } : { thr: r.removalThresholdJPerMm2, k: r.depthMmPerJPerMm2 }
    const minThr = r.kind === 'char' ? r.toneStartJPerMm2 : r.frostFullJPerMm2
    depth = fitDepth(fit.w, fields, input.depths, kept, minThr)
    if (depth) {
      const thr = Number(depth.thresholdJPerMm2.toPrecision(4))
      const k = Number(depth.depthMmPerJPerMm2.toPrecision(4))
      if (r.kind === 'char') {
        r.ablationThresholdJPerMm2 = Math.max(thr, r.toneStartJPerMm2)
        r.depthMmPerJPerMm2 = k
      } else if (r.kind === 'melt') {
        r.removalThresholdJPerMm2 = Math.max(thr, r.frostFullJPerMm2)
        r.depthMmPerJPerMm2 = k
      }
    }
  } else if (fitted.response.kind !== 'bleach') notes.push('No depths entered: the depth threshold and scale are kept from the starting profile.')
  // Fire
  let fire: FireFit | null = null
  if (input.fireCellIds !== undefined && fitted.fireRisk.kind === 'temperature') {
    fire = fitFire(fit.w, fields, input.fireCellIds, fitted.fireRisk.thresholdK)
    if (fire) fitted.fireRisk = { kind: 'temperature', thresholdK: fire.thresholdK }
  } else if (input.fireCellIds !== undefined && fitted.fireRisk.kind !== 'temperature') {
    notes.push('Fire flags need a temperature fire-risk threshold (peakTemperature thermal model); ignored.')
  }
  const meanDeltaE = fit.cells.reduce((s, c) => s + c.deltaE, 0) / fit.cells.length
  const maxDeltaE = Math.max(...fit.cells.map((c) => c.deltaE))
  const when = input.fittedAt ?? new Date().toISOString()
  fitted = {
    ...fitted,
    id: input.id ?? `${start.id.replace(/-provisional$|-calibrated(-\d+)?$/, '')}-calibrated`,
    name: input.name ?? `${start.name.replace(/ \(provisional\)$/, '')} (calibrated)`,
    provenance: {
      source: 'calibrated',
      label: 'calibrated from a photographed test grid — not checked on held-out burns',
      notes: `Fitted from ${fit.cells.length} grid cells (BURN-15) starting from ${start.id}. Mean ΔE00 ${meanDeltaE.toFixed(2)}, max ${maxDeltaE.toFixed(2)}.`,
      fittedAt: when,
      meanDeltaE: Number(meanDeltaE.toFixed(3)),
    },
  }
  let powerFactors: FitResult['powerFactors'] = null
  let powerCurve: PowerCurvePoint[] | null = null
  if (power) {
    const reports = fit.parameters.slice(fit.parameters.length - steps.length)
    powerFactors = [
      { sFraction: power.anchor, factor: 1, constrained: true, anchor: true },
      ...steps.map((s, i) => ({ sFraction: s, factor: fit.w.power.get(s) ?? 1, constrained: reports[i]!.constrained && power.midCells.get(s)! > 0, anchor: false })),
    ].sort((a, b) => a.sFraction - b.sFraction)
    powerCurve = proposePowerCurve(input.machine, powerFactors)
    notes.push(
      `S → power: factors are relative to S ${(power.anchor * 100).toFixed(1)} %, whose nominal power is taken as right` +
        (power.anchor < 1 ? ' (the S max column had fewer than two cells inside the ramp).' : '.') +
        ' Steps with no cell inside the ramp keep the nominal curve.',
    )
  }
  return {
    material: fitted,
    powerCurve,
    powerFactors,
    cells: fit.cells,
    meanDeltaE,
    maxDeltaE,
    parameters: fit.parameters,
    depth,
    fire,
    thermalIterations: iterations,
    notes,
  }
}

/** Predicted cell colours for a profile without fitting (the review's "before" column, and tests). */
export function predictCells(fields: CellFields, material: MaterialProfile): { id: string; lab: Lab }[] {
  const w = working(material)
  const lut = colourLut(w)
  const hist = new Float64Array(BINS)
  return fields.cells.map((c) => ({ id: c.id, lab: predictCell(w, c, hist, lut) }))
}

export { cellFields }

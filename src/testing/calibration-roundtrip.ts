// SPDX-License-Identifier: MIT
// Round-trip harness for the photo fit (BURN-15): simulate a grid from known
// ("true") parameters, photograph it synthetically under given conditions,
// analyse the photo, fit, and compare recovered with true parameters.
//
// Truth and fit use the same thermal step. In tests that is the CPU reference
// on a coarser thermal grid (THERMAL_TEST_STEP) so each run takes seconds, not
// a minute; the fit is still checked against the thermal model, only at a
// lower resolution than the app's.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  analysePhoto,
  cellFields,
  fitMaterial,
  generatePattern,
  renderPattern,
  syntheticPhoto,
  type CalibrationPattern,
  type DepthEntry,
  type FitResult,
  type PhotoAnalysis,
  type PhotoConditions,
} from '../calibration/index.ts'
import { decodeSampleBatch, type MachineProfile, type MaterialProfile } from '../contract/index.ts'
import { CpuPeakTemperatureStep, SampleStore, interimSampler, loadMachineProfile, loadMaterialProfile, type ThermalStep } from '../sim/index.ts'

const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')
export const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
export const provisionalMaterial = (file: string) => loadMaterialProfile(provisional(file))

/** Thermal step for tests: the CPU reference on a 0.5 mm grid with 2 s bins. */
export const THERMAL_TEST_STEP: ThermalStep = new CpuPeakTemperatureStep({ pitchMm: 0.5, binS: 2 })

/** True materials: each provisional profile moved well away from its starting values. */
export function trueMaterial(start: MaterialProfile): MaterialProfile {
  const m = structuredClone(start)
  const r = m.response
  switch (r.kind) {
    case 'char':
      r.baseColor = { l: 77, a: 8.5, b: 23 }
      r.charColor = { l: 24, a: 7, b: 9 }
      r.toneStartJPerMm2 = 0.182
      r.toneEndJPerMm2 = 1.44
      r.toneGamma = 0.55
      r.ablationThresholdJPerMm2 = 0.6
      r.depthMmPerJPerMm2 = 0.12
      if (m.thermal.kind === 'peakTemperature') m.thermal.rampOnsetK = 560
      if (m.fireRisk.kind === 'temperature') m.fireRisk.thresholdK = 780
      break
    case 'melt':
      r.baseColor = { l: 9, a: 0.5, b: -0.5 }
      r.frostColor = { l: 55, a: 0, b: -2 }
      r.frostStartJPerMm2 = 0.14
      r.frostFullJPerMm2 = 0.3625
      r.removalThresholdJPerMm2 = 1.4
      r.depthMmPerJPerMm2 = 0.25
      if (m.thermal.kind === 'peakTemperature') m.thermal.rampOnsetK = 600
      break
    case 'bleach':
      r.baseColor = { l: 24, a: 0.5, b: -1 }
      r.markColor = { l: 75, a: 1, b: 4 }
      r.markStartJPerMm2 = 0.572
      r.markFullJPerMm2 = 2.36
      break
  }
  return m
}

/** Photo conditions used by the round-trip tests. */
export const CONDITIONS: Record<string, PhotoConditions> = {
  mild: {
    seed: 11,
    rotationDeg: 3,
    perspective: 0.02,
    whiteBalance: [1.05, 1, 0.95],
    exposure: 1,
    gradient: { strength: 0.05, angleDeg: 20 },
    vignette: 0.02,
    blurPx: 0.8,
    noise: { read: 0.001, shot: 0.005 },
  },
  harsh: {
    seed: 23,
    rotationDeg: 97,
    perspective: 0.06,
    cardSide: 'below',
    cardAngleDeg: 12,
    whiteBalance: [1.3, 1, 0.7],
    exposure: 0.6,
    gradient: { strength: 0.15, angleDeg: 120 },
    vignette: 0.08,
    blurPx: 1.6,
    noise: { read: 0.004, shot: 0.02 },
    texture: 0.03,
    cardPrintErrorDE: 1,
  },
  upsideDown: {
    seed: 37,
    rotationDeg: 183,
    perspective: 0.04,
    cardSide: 'left',
    cardAngleDeg: -7,
    whiteBalance: [0.85, 1, 1.2],
    exposure: 1.3,
    gradient: { strength: 0.1, angleDeg: 250 },
    vignette: 0.05,
    blurPx: 1.2,
    noise: { read: 0.002, shot: 0.012 },
  },
}

export function sampleJob(pattern: CalibrationPattern, m: MachineProfile): SampleStore {
  const plan = interimSampler.plan(pattern.job, m, 1)
  const store = new SampleStore(1)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  return store
}

export interface Truth {
  pattern: CalibrationPattern
  truth: MaterialProfile
  start: MaterialProfile
  /** Store the photo is rendered from (true machine). */
  trueStore: SampleStore
  /** Store the fit simulates with (the machine profile the user has). */
  fitStore: SampleStore
  thermalStep: ThermalStep
  depths: DepthEntry[]
  fireCellIds: string[] | undefined
}

/**
 * The grid for `file`'s material, its true material, and what the user would
 * enter by hand: depths on three cells, and the cells that flamed.
 */
export function makeTruth(file: string, options: { trueMachine?: MachineProfile; depthNoiseMm?: number; grid?: Record<string, unknown> } = {}): Truth {
  const start = provisionalMaterial(file)
  const truth = trueMaterial(start)
  const pattern = generatePattern('grid', machine, start, options.grid ? { pattern: options.grid } : {})
  const trueMachine = options.trueMachine ?? machine
  const trueStore = sampleJob(pattern, trueMachine)
  const fitStore = trueMachine === machine ? trueStore : sampleJob(pattern, machine)
  const thermalStep = THERMAL_TEST_STEP
  // What a depth gauge reads on three cells: the most burned, a middle one, a light one.
  const fields = cellFields(trueStore, trueMachine, truth, pattern.cells, { thermalStep })
  const depths: DepthEntry[] = []
  const r = truth.response
  if (r.kind !== 'bleach') {
    const thr = r.kind === 'char' ? r.ablationThresholdJPerMm2 : r.removalThresholdJPerMm2
    const flashK = truth.thermal.kind === 'peakTemperature' ? (truth.thermal.rampOnsetK - truth.thermal.ambientK) / (r.kind === 'char' ? r.toneStartJPerMm2 : r.frostStartJPerMm2) : null
    const depthOf = (c: (typeof fields.cells)[number]) => {
      let s = 0
      for (let i = 0; i < c.flash.length; i++) s += Math.max(0, (flashK === null ? c.flash[i]! : c.flash[i]! + c.bulk[i]! / flashK) - thr)
      return (r.depthMmPerJPerMm2 * s) / c.flash.length
    }
    const ranked = fields.cells.map((c) => ({ id: c.id, d: depthOf(c) })).sort((a, b) => b.d - a.d)
    const noise = options.depthNoiseMm ?? 0.005
    for (const [k, pick] of [ranked[0]!, ranked[Math.floor(ranked.length / 4)]!, ranked[Math.floor(ranked.length / 2)]!].entries())
      depths.push({ cellId: pick.id, depthMm: Math.max(0, Number((pick.d + (k - 1) * noise).toFixed(3))) })
  }
  const fireCellIds =
    truth.fireRisk.kind === 'temperature' ? fields.cells.filter((c) => c.bulkMaxK >= (truth.fireRisk as { thresholdK: number }).thresholdK).map((c) => c.id) : undefined
  return { pattern, truth, start, trueStore, fitStore, thermalStep, depths, fireCellIds }
}

export interface RoundTrip {
  analysis: PhotoAnalysis
  fit: FitResult
  photo: ReturnType<typeof syntheticPhoto>
}

const renderCache = new WeakMap<Truth, ReturnType<typeof renderPattern>>()

export function roundTrip(t: Truth, conditions: PhotoConditions, options: { fitPowerCurve?: boolean; trueMachine?: MachineProfile } = {}): RoundTrip {
  const b = t.pattern.boundsMm
  let render = renderCache.get(t)
  if (!render) {
    render = renderPattern(
      t.trueStore,
      options.trueMachine ?? machine,
      t.truth,
      { minXMm: b.minXMm - 14, minYMm: b.minYMm - 14, maxXMm: b.maxXMm + 14, maxYMm: b.maxYMm + 14 },
      // Rendered at 25 µm, fitted at 10 µm: the fit never sees its own grid.
      { finePitchMm: 0.025, thermalStep: t.thermalStep },
    )
    renderCache.set(t, render)
  }
  const photo = syntheticPhoto(render, t.truth.response.baseColor, conditions)
  const r = t.start.response
  const marksLighter = (r.kind === 'char' ? r.charColor.l : r.kind === 'melt' ? r.frostColor.l : r.markColor.l) > r.baseColor.l
  const analysis = analysePhoto(photo.photo, t.pattern, { marksLighter })
  const fit = fitMaterial({
    cells: t.pattern.cells,
    store: t.fitStore,
    machine,
    material: t.start,
    observations: analysis.observations,
    base: analysis.base,
    depths: t.depths,
    fireCellIds: t.fireCellIds,
    fitPowerCurve: options.fitPowerCurve,
    forward: { thermalStep: t.thermalStep },
    fittedAt: '2026-11-06T00:00:00.000Z',
  })
  return { analysis, fit, photo }
}

/** Recovered vs true values of everything the fit sets, for the report. */
export function compare(truth: MaterialProfile, fitted: MaterialProfile): { name: string; truth: number; fitted: number; relErr: number; absErr: number }[] {
  const rows: { name: string; truth: number; fitted: number }[] = []
  const t = truth.response as unknown as Record<string, unknown>
  const f = fitted.response as unknown as Record<string, unknown>
  for (const k of Object.keys(t)) {
    const tv = t[k]
    const fv = f[k]
    if (typeof tv === 'number') rows.push({ name: k, truth: tv, fitted: fv as number })
    else if (tv && typeof tv === 'object') for (const c of ['l', 'a', 'b'] as const) rows.push({ name: `${k}.${c}`, truth: (tv as Record<string, number>)[c]!, fitted: (fv as Record<string, number>)[c]! })
  }
  if (truth.thermal.kind === 'peakTemperature' && fitted.thermal.kind === 'peakTemperature') rows.push({ name: 'rampOnsetK', truth: truth.thermal.rampOnsetK, fitted: fitted.thermal.rampOnsetK })
  if (truth.fireRisk.kind === 'temperature' && fitted.fireRisk.kind === 'temperature') rows.push({ name: 'fireRisk.thresholdK', truth: truth.fireRisk.thresholdK, fitted: fitted.fireRisk.thresholdK })
  return rows.map((r) => ({ ...r, absErr: r.fitted - r.truth, relErr: r.truth !== 0 ? (r.fitted - r.truth) / Math.abs(r.truth) : NaN }))
}

/**
 * Stated tolerances of the round trip (BURN-15), per recovered field: `rel`
 * is a fraction of the true value, `abs` an absolute difference. A field
 * listed as `interval` passes when the truth lies inside the fit's stated
 * interval (fire threshold: between the hottest calm and the coolest flaming
 * cell). `sigma` checks the truth is within that many reported σ instead of a
 * fixed tolerance (melt's rampOnsetK, which the grid barely constrains).
 */
export type Tolerance = { rel: number } | { abs: number } | { sigma: number } | { interval: true }

const COLOUR = { abs: 1.5 }
export const TOLERANCES: Record<'char' | 'melt' | 'bleach', Record<string, Tolerance>> = {
  char: {
    'baseColor.l': COLOUR,
    'baseColor.a': COLOUR,
    'baseColor.b': COLOUR,
    'charColor.l': COLOUR,
    'charColor.a': COLOUR,
    'charColor.b': COLOUR,
    toneStartJPerMm2: { rel: 0.06 },
    toneEndJPerMm2: { rel: 0.04 },
    toneGamma: { rel: 0.03 },
    rampOnsetK: { rel: 0.12 },
    // Depth from three gauge readings with ±0.005 mm error, one on a 0.05 mm-deep cell.
    ablationThresholdJPerMm2: { rel: 0.15 },
    depthMmPerJPerMm2: { rel: 0.05 },
    'fireRisk.thresholdK': { interval: true },
  },
  melt: {
    'baseColor.l': COLOUR,
    'baseColor.a': COLOUR,
    'baseColor.b': COLOUR,
    'frostColor.l': COLOUR,
    'frostColor.a': COLOUR,
    'frostColor.b': COLOUR,
    frostStartJPerMm2: { rel: 0.04 },
    frostFullJPerMm2: { rel: 0.04 },
    removalThresholdJPerMm2: { rel: 0.04 },
    depthMmPerJPerMm2: { rel: 0.04 },
    rampOnsetK: { sigma: 2 },
    'fireRisk.thresholdK': { interval: true },
  },
  bleach: {
    'baseColor.l': COLOUR,
    'baseColor.a': COLOUR,
    'baseColor.b': COLOUR,
    'markColor.l': COLOUR,
    'markColor.a': COLOUR,
    'markColor.b': COLOUR,
    markStartJPerMm2: { rel: 0.03 },
    markFullJPerMm2: { rel: 0.02 },
  },
}

/** Mean ΔE00 between fitted and photographed cells must stay under this. */
export const MAX_MEAN_DELTA_E = 1

export interface CheckRow {
  name: string
  truth: number
  fitted: number
  error: string
  tolerance: string
  pass: boolean
}

/** Every toleranced field of a round trip: recovered vs true, and whether it is within tolerance. */
export function check(t: Truth, rt: RoundTrip): CheckRow[] {
  const tol = TOLERANCES[t.truth.response.kind]
  const rows = compare(t.truth, rt.fit.material)
  const sigmaOf = (name: string) => {
    if (name !== 'rampOnsetK') return null
    return rt.fit.parameters.find((p) => p.name.startsWith('rampOnsetK'))?.sigma ?? null
  }
  return Object.entries(tol).map(([name, tl]) => {
    const r = rows.find((x) => x.name === name)
    if (!r) return { name, truth: NaN, fitted: NaN, error: 'missing', tolerance: '', pass: false }
    if ('interval' in tl) {
      const f = rt.fit.fire
      const pass = !!f && r.truth >= f.lowerK && r.truth <= f.upperK
      return { name, truth: r.truth, fitted: r.fitted, error: `${r.absErr >= 0 ? '+' : ''}${r.absErr.toFixed(0)} K`, tolerance: f ? `in [${f.lowerK.toFixed(0)}, ${f.upperK.toFixed(0)}] K` : 'interval', pass }
    }
    if ('sigma' in tl) {
      const s = sigmaOf(name)
      const pass = s !== null && Math.abs(r.absErr) <= tl.sigma * s
      return { name, truth: r.truth, fitted: r.fitted, error: `${r.absErr >= 0 ? '+' : ''}${r.absErr.toFixed(1)}`, tolerance: `≤ ${tl.sigma} σ (σ = ${s?.toFixed(0)})`, pass }
    }
    if ('rel' in tl)
      return { name, truth: r.truth, fitted: r.fitted, error: `${r.relErr >= 0 ? '+' : ''}${(r.relErr * 100).toFixed(1)} %`, tolerance: `±${(tl.rel * 100).toFixed(0)} %`, pass: Math.abs(r.relErr) <= tl.rel }
    return { name, truth: r.truth, fitted: r.fitted, error: `${r.absErr >= 0 ? '+' : ''}${r.absErr.toFixed(2)}`, tolerance: `±${tl.abs}`, pass: Math.abs(r.absErr) <= tl.abs }
  })
}

/** One round trip as a worker job (calibration-roundtrip.worker.ts). */
export interface RoundTripJob {
  file: string
  condition: string
  fitPowerCurve?: boolean
  trueCurve?: MachineProfile['powerCurve']
  grid?: Record<string, unknown>
}

export interface RoundTripOutcome {
  rows: CheckRow[]
  meanDeltaE: number
  maxDeltaE: number
  powerFactors: FitResult['powerFactors']
  material: MaterialProfile
  truth: MaterialProfile
  warnings: string[]
  patchDeltaE: number
}

export async function roundTripInWorker(job: RoundTripJob): Promise<RoundTripOutcome> {
  const { Worker } = await import('node:worker_threads')
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./calibration-roundtrip.worker.ts', import.meta.url), { workerData: job, execArgv: ['--import', 'tsx'] })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`round-trip worker exited with ${code} before posting`)))
  })
}

// SPDX-License-Identifier: MIT
// Outcome explanation (BURN-45): why one cell got its verdict. The hover
// readout says what a cell is; this says which moves made it so and why.
//
// It walks the same samples the readout does (CellReader.visit: the bucket
// index around the cell, weighted by bilinear × blur kernel exactly as the
// deposit is), so per-move contributions sum to the readout's fluence (and
// dose) to rounding. Nothing is read back from the GPU; a query touches only
// the samples within kernel reach of the cell, so it answers at click speed
// at any zoom and while a live job keeps streaming.
//
// Causes for an over-burned cell are counterfactuals on those same sums:
//   slowdown          M3 samples that ran well under the commanded speed
//                     (corners, short moves, raster turnarounds), re-weighted
//                     to the energy they'd have put down at it (M4 already
//                     scales power with speed, so it mostly doesn't over-burn
//                     there);
//   heat build-up     the dose a sample got from preheat left by earlier
//                     lines (eDose − eAbs · flash), or a bulk temperature
//                     past a temperature fire-risk threshold;
//   overlap           neighbouring moves adding up: the top move alone;
//   passes            more than one pass over the cell: the top pass alone;
//   settings          the top move alone, at speed, without preheat, is
//                     already past the threshold: power too high for speed.
// A cause is reported when removing it would lower the verdict. Bulk
// temperature (a temperature fire risk) is scaled with the cell's absorbed
// energy for the slowdown, overlap and passes counterfactuals: a heuristic,
// since bulk heat also comes from the neighbourhood.

import {
  UNTOUCHED_FRACTION,
  Verdict,
  classifyFluence,
  classifyThermal,
  verdictThresholds,
  type CellReadout,
  type JobModel,
  type LaserMode,
  type MaterialProfile,
  type Move,
} from '../contract/index.ts'
import type { CellReader } from './readout.ts'
import {
  cachedFlashTable,
  freshStaticsMemo,
  peakTemperatureModel,
  staticsRange,
  type ThermalResult,
} from './thermal.ts'
import type { SampleStore } from './sample-store.ts'

/** Moves listed per explanation, most contributing first. */
export const EXPLAIN_MAX_MOVES = 5
/** A sample counts as slowed when it ran under this fraction of its commanded speed. */
export const EXPLAIN_SLOW_FRACTION = 0.7

/** One move's (one G-code line's) share of a cell. */
export interface MoveContribution {
  /** 1-based G-code line. */
  line: number
  /** Pass the move is in, and its label from sender comments; null without a job model. */
  passIndex: number | null
  passLabel: string | null
  /** M3 / M4 in effect; null without a job model. */
  laser: LaserMode | null
  /** Commanded S (raw) and as a fraction of $30; null without a job model. */
  s: number | null
  powerFraction: number | null
  /** Commanded feed (mm/min) after the machine's max-rate cap; null without a job model. */
  commandedMmPerMin: number | null
  /** Actual planner speed over the samples that reached the cell: weighted mean and minimum (mm/min). */
  actualMmPerMin: number
  minActualMmPerMin: number
  /** Optical power over those samples (W, weighted mean; M4 scales it with speed). */
  powerW: number
  /** This move's part of the cell's fluence (J/mm²), and of its thermal dose (null without a thermal model). */
  fluenceJPerMm2: number
  doseJPerMm2: number | null
  /** Fraction of the quantity the verdict reads (dose with a thermal model, else fluence). */
  share: number
  /** When the contributing samples burned (s, absolute job time). */
  fromS: number
  toS: number
  /** The contributing sample nearest the cell's peak weight, for highlighting the move. */
  atXMm: number
  atYMm: number
}

/** What set the verdict: the measured value and the threshold it crossed (or stayed under). */
export interface VerdictReason {
  /** What was compared: fluence, thermal dose, or bulk temperature (fire risk by temperature). */
  quantity: 'fluence' | 'dose' | 'bulkTemperature'
  value: number
  /** The deciding threshold, in the quantity's unit (J/mm² or K). */
  threshold: number
  /** fire: at/over the fire threshold; over: past the top; inRange: between; under: below the start; untouched: below a trace. */
  bound: 'fire' | 'over' | 'inRange' | 'under' | 'untouched'
  /** The material's mark window (J/mm², in the verdict's dose or fluence). */
  underBelow: number
  overAbove: number
}

export type CauseKind = 'slowdown' | 'heat-build-up' | 'overlap' | 'passes' | 'settings'

export interface OverburnCause {
  kind: CauseKind
  /** Fraction of the verdict quantity this cause accounts for (0–1; 1 for settings). */
  share: number
  /** The verdict quantity without it (J/mm², or K for a temperature fire risk), and the verdict that would give. */
  withoutValue: number
  verdictWithout: Verdict
  /** Lines involved (slowed lines, overlapping lines, the top move), most first. */
  lines: number[]
  /** slowdown: weighted actual ÷ commanded speed over the slowed samples. */
  speedRatio?: number
  /** passes: number of passes over the cell. */
  passCount?: number
}

export interface CellExplanation {
  readout: CellReadout
  /** Total over every contributing move: equals the readout's fluence (and dose) to rounding. */
  fluenceJPerMm2: number
  doseJPerMm2: number | null
  /** Moves that reached the cell, and the top EXPLAIN_MAX_MOVES of them by share. */
  moveCount: number
  moves: MoveContribution[]
  /** Share of the verdict quantity the listed moves carry. */
  listedShare: number
  /** Thermal dose from preheat left by earlier lines (J/mm²) and its share; null without a thermal model. */
  preheatDoseJPerMm2: number | null
  reason: VerdictReason
  /** For Over / FireRisk cells: causes that lowered the verdict when removed, strongest first. Empty otherwise. */
  causes: OverburnCause[]
}

interface MoveInfo {
  move: Move
  passIndex: number
  passLabel: string | null
  commandedMmPerMin: number
}

const moveIndex = new WeakMap<JobModel, Map<number, MoveInfo>>()

/** Max feed along a direction, as the planner caps it ($110/$111). */
function rateAlong(ux: number, uy: number, limitX: number, limitY: number): number {
  let v = Infinity
  if (Math.abs(ux) > 1e-12) v = Math.min(v, limitX / Math.abs(ux))
  if (Math.abs(uy) > 1e-12) v = Math.min(v, limitY / Math.abs(uy))
  return v
}

/** Line → first beam-on move on it (arcs flatten to several chords on one line; they share feed and S). */
function movesByLine(job: JobModel, maxRate: { x: number; y: number }): Map<number, MoveInfo> {
  let map = moveIndex.get(job)
  if (map) return map
  map = new Map()
  let x = job.startMm.xMm
  let y = job.startMm.yMm
  for (const pass of job.passes) {
    for (let i = pass.firstMove; i < pass.firstMove + pass.moveCount; i++) {
      const move = job.moves[i]!
      const dx = move.xMm - x
      const dy = move.yMm - y
      const len = Math.hypot(dx, dy)
      if (!map.has(move.line) && move.kind === 'g1' && len > 0) {
        const cap = rateAlong(dx / len, dy / len, maxRate.x, maxRate.y)
        map.set(move.line, { move, passIndex: pass.index, passLabel: pass.label ?? null, commandedMmPerMin: Math.min(move.feedMmPerMin, cap) })
      }
      x = move.xMm
      y = move.yMm
    }
  }
  moveIndex.set(job, map)
  return map
}

interface Acc {
  line: number
  fluence: number
  dose: number
  /** Verdict quantity, and Σ q·v, Σ q·P for weighted means. */
  q: number
  qv: number
  qp: number
  minV: number
  fromS: number
  toS: number
  bestW: number
  atX: number
  atY: number
  /** Own-pass dose (no preheat), and the verdict quantity re-weighted to the commanded speed. */
  own: number
  atSpeed: number
  /** Fluence re-weighted to the commanded speed (for the bulk-temperature counterfactual). */
  atSpeedFl: number
  slowQ: number
  slowQv: number
  slowQvc: number
}

/** Per-sample flash factors for the samples an explanation touches, cached per store version. */
class FlashCache {
  version = -1
  flash = new Float32Array(0)
  gain = new Float32Array(0)
  done = new Uint8Array(0)
  get(store: SampleStore, n: number): this {
    if (this.version !== store.version || this.flash.length < n) {
      this.version = store.version
      this.flash = new Float32Array(n)
      this.gain = new Float32Array(n)
      this.done = new Uint8Array(n)
    }
    return this
  }
}

const flashCaches = new WeakMap<CellReader, FlashCache>()

function reasonFor(material: MaterialProfile, readout: CellReadout, thermal: boolean): VerdictReason {
  const { underBelow, overAbove } = verdictThresholds(material.response)
  const value = thermal ? readout.doseJPerMm2! : readout.fluenceJPerMm2
  const quantity = thermal ? 'dose' : 'fluence'
  const fire = material.fireRisk
  const base = { quantity, value, underBelow, overAbove } as const
  switch (readout.verdict) {
    case Verdict.FireRisk:
      if (fire.kind === 'temperature' && readout.bulkTemperatureK !== null && readout.bulkTemperatureK >= fire.thresholdK)
        return { ...base, quantity: 'bulkTemperature', value: readout.bulkTemperatureK, threshold: fire.thresholdK, bound: 'fire' }
      return { ...base, threshold: fire.kind === 'fluence' ? fire.thresholdJPerMm2 : overAbove, bound: 'fire' }
    case Verdict.Over:
      return { ...base, threshold: overAbove, bound: 'over' }
    case Verdict.InRange:
      return { ...base, threshold: underBelow, bound: 'inRange' }
    case Verdict.Under:
      return { ...base, threshold: underBelow, bound: 'under' }
    default:
      return { ...base, threshold: UNTOUCHED_FRACTION * underBelow, bound: 'untouched' }
  }
}

/**
 * Explains cell (cx, cy) of the reader's grid for samples up to the cutoff:
 * the moves that made it, the threshold that set its verdict and, for an
 * over-burned cell, the likely causes. `job` (the parsed job model) adds
 * commanded feed, S, M3/M4 and pass per move; without it (a live job before
 * job.loaded) those fields are null and the corner check is skipped.
 */
export function explainCell(reader: CellReader, store: SampleStore, cx: number, cy: number, timeCutoffS = Infinity, job: JobModel | null = null): CellExplanation {
  const setup = reader.simSetup
  const { grid, material, machine } = setup
  const readout = reader.readCell(cx, cy, timeCutoffS)
  const limit = store.countUntil(timeCutoffS)
  const thermal: ThermalResult | null = reader.thermal()
  const model = peakTemperatureModel(material)
  const inv2 = 1 / (grid.pitchMm * grid.pitchMm)
  const scale = material.absorption * inv2
  const moves = job ? movesByLine(job, machine.maxRateMmPerMin) : null

  // Flash factors (own-pass dose) for touched samples only; same statics as the thermal step.
  let flash: FlashCache | null = null
  let table: ReturnType<typeof cachedFlashTable> | null = null
  if (thermal && model && thermal.plan) {
    let c = flashCaches.get(reader)
    if (!c) flashCaches.set(reader, (c = new FlashCache()))
    flash = c.get(store, store.count)
    table = cachedFlashTable(machine, setup.thermalKernel, model, thermal.plan.nearS)
  }

  const acc = new Map<number, Acc>()
  const { xye, tS, dtS, speedMmPerS, line } = store
  reader.visit(cx, cy, limit, (s, w) => {
    const l = line[s]!
    let a = acc.get(l)
    if (!a) {
      a = { line: l, fluence: 0, dose: 0, q: 0, qv: 0, qp: 0, minV: Infinity, fromS: Infinity, toS: -Infinity, bestW: 0, atX: 0, atY: 0, own: 0, atSpeed: 0, atSpeedFl: 0, slowQ: 0, slowQv: 0, slowQvc: 0 }
      acc.set(l, a)
    }
    const fl = thermal ? w * thermal.eAbs[s]! * inv2 : w * xye[s * 3 + 2]! * scale
    const dose = thermal ? w * thermal.eDose[s]! * inv2 : 0
    const q = thermal ? dose : fl
    const v = speedMmPerS[s]! * 60
    const p = xye[s * 3 + 2]! / Math.max(dtS[s]!, 1e-12)
    a.fluence += fl
    a.dose += dose
    a.q += q
    a.qv += q * v
    a.qp += q * p
    if (v < a.minV) a.minV = v
    if (tS[s]! < a.fromS) a.fromS = tS[s]!
    if (tS[s]! > a.toS) a.toS = tS[s]!
    if (w > a.bestW) {
      a.bestW = w
      a.atX = xye[s * 3]!
      a.atY = xye[s * 3 + 1]!
    }
    if (flash && table && model) {
      if (!flash.done[s]) {
        staticsRange(store, s, s + 1, table, material, model, freshStaticsMemo(), flash.flash, flash.gain)
        flash.done[s] = 1
      }
      a.own += fl * flash.flash[s]!
    }
    // Counterfactual at the commanded speed: an M3 sample that ran slow put down energy ∝ 1/v.
    const info = moves?.get(l)
    const vc = info?.commandedMmPerMin ?? 0
    if (info && vc > 0 && v < EXPLAIN_SLOW_FRACTION * vc) {
      a.slowQ += q
      a.slowQv += q * v
      a.slowQvc += q * vc
      const k = info.move.laser === 'm3' ? v / vc : 1
      a.atSpeed += q * k
      a.atSpeedFl += fl * k
    } else {
      a.atSpeed += q
      a.atSpeedFl += fl
    }
  })

  const all = [...acc.values()].sort((x, y) => y.q - x.q)
  let fluence = 0
  let dose = 0
  let q = 0
  let own = 0
  for (const a of all) {
    fluence += a.fluence
    dose += a.dose
    q += a.q
    own += a.own
  }
  const listed = all.slice(0, EXPLAIN_MAX_MOVES).map((a): MoveContribution => {
    const info = moves?.get(a.line) ?? null
    return {
      line: a.line,
      passIndex: info?.passIndex ?? null,
      passLabel: info?.passLabel ?? null,
      laser: info?.move.laser ?? null,
      s: info?.move.s ?? null,
      powerFraction: info ? Math.min(1, info.move.s / machine.sMax) : null,
      commandedMmPerMin: info?.commandedMmPerMin ?? null,
      actualMmPerMin: a.q > 0 ? a.qv / a.q : a.minV,
      minActualMmPerMin: a.minV,
      powerW: a.q > 0 ? a.qp / a.q : 0,
      fluenceJPerMm2: a.fluence,
      doseJPerMm2: thermal ? a.dose : null,
      share: q > 0 ? a.q / q : 0,
      fromS: a.fromS,
      toS: a.toS,
      atXMm: a.atX,
      atYMm: a.atY,
    }
  })

  const isThermal = thermal !== null
  const reason = reasonFor(material, readout, isThermal)
  const preheat = isThermal && flash ? Math.max(0, dose - own) : null
  const causes: OverburnCause[] = []
  const verdict = readout.verdict
  if (verdict === Verdict.Over || verdict === Verdict.FireRisk) {
    const bulk = readout.bulkTemperatureK ?? 0
    const classify = (value: number, bulkK = bulk) => (isThermal ? classifyThermal(material, value, bulkK) : classifyFluence(material, value))
    const add = (kind: CauseKind, without: number, lines: number[], extra: Partial<OverburnCause> = {}, bulkK = bulk) => {
      const verdictWithout = classify(without, bulkK)
      if (verdictWithout < verdict || kind === 'settings')
        causes.push({ kind, share: q > 0 ? Math.min(1, Math.max(0, (q - without) / q)) : 0, withoutValue: without, verdictWithout, lines, ...extra })
    }
    const ambient = thermal?.ambientK ?? 0
    const bulkScaled = (flWithout: number) => (fluence > 0 ? ambient + (bulk - ambient) * Math.min(1, flWithout / fluence) : bulk)
    // Heat build-up: dose without preheat; a temperature fire risk is built-up heat by definition.
    if (preheat !== null && preheat > 0) add('heat-build-up', q - preheat, all.slice(0, 3).map((a) => a.line), {}, ambient)
    else if (reason.quantity === 'bulkTemperature') add('heat-build-up', q, [], {}, ambient)
    // Slowdown (M3 only changes the energy; M4 already scaled it).
    const slow = all.filter((a) => a.slowQ > 0).sort((x, y) => y.slowQ - x.slowQ)
    const atSpeed = all.reduce((t, a) => t + a.atSpeed, 0)
    if (slow.length && atSpeed < q) {
      const sq = slow.reduce((t, a) => t + a.slowQv, 0)
      const sc = slow.reduce((t, a) => t + a.slowQvc, 0)
      const fl = all.reduce((t, a) => t + a.atSpeedFl, 0)
      add('slowdown', atSpeed, slow.slice(0, 3).map((a) => a.line), { speedRatio: sc > 0 ? sq / sc : 1 }, bulkScaled(fl))
    }
    // Overlap and passes: the top move, or the top pass, alone.
    const top = all[0]
    if (top && all.length > 1) add('overlap', top.q, all.slice(0, 4).map((a) => a.line), {}, bulkScaled(top.fluence))
    if (moves) {
      const byPass = new Map<number, [q: number, fl: number]>()
      for (const a of all) {
        const p = moves.get(a.line)?.passIndex
        if (p === undefined) continue
        const b = byPass.get(p) ?? [0, 0]
        byPass.set(p, [b[0] + a.q, b[1] + a.fluence])
      }
      if (byPass.size > 1) {
        const [bq, bfl] = [...byPass.values()].sort((x, y) => y[0] - x[0])[0]!
        add('passes', bq, [], { passCount: byPass.size }, bulkScaled(bfl))
      }
    }
    // Settings: the top move by itself, at speed and without preheat, is already over.
    if (top) {
      const topOwn = isThermal && flash ? top.own : top.q
      const ratio = top.q > 0 ? top.atSpeed / top.q : 1
      const alone = topOwn * ratio
      if (classify(alone, ambient) >= Verdict.Over) causes.push({ kind: 'settings', share: 1, withoutValue: alone, verdictWithout: classify(alone, ambient), lines: [top.line] })
    }
    causes.sort((x, y) => (x.kind === 'settings' ? 1 : 0) - (y.kind === 'settings' ? 1 : 0) || y.share - x.share)
  }

  return {
    readout,
    fluenceJPerMm2: fluence,
    doseJPerMm2: isThermal ? dose : null,
    moveCount: all.length,
    moves: listed,
    listedShare: listed.reduce((t, m) => t + m.share, 0),
    preheatDoseJPerMm2: preheat,
    reason,
    causes,
  }
}

/** explainCell at an absolute machine position; null outside the reader's grid. */
export function explainAt(reader: CellReader, store: SampleStore, xMm: number, yMm: number, timeCutoffS = Infinity, job: JobModel | null = null): CellExplanation | null {
  const { grid } = reader.simSetup
  const cx = Math.floor((xMm - grid.originXMm) / grid.pitchMm)
  const cy = Math.floor((yMm - grid.originYMm) / grid.pitchMm)
  if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return null
  return explainCell(reader, store, cx, cy, timeCutoffS, job)
}

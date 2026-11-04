// SPDX-License-Identifier: MIT
// What a pattern generator knows about the machine and material: the bed,
// the power curve and its inverse, speed and acceleration limits, overscan,
// and the energy targets the material's thresholds suggest.

import {
  interpolateCurve,
  verdictThresholds,
  type MachineProfile,
  type MaterialProfile,
} from '../contract/index.ts'
import { findFrame } from '../profiles/catalog/index.ts'
import type { CellSettings, PatternMachineInfo, ScanAxis } from './types.ts'

/** Slowest feed a pattern uses (mm/min); slower than this a diode just burns through. */
export const MIN_FEED_MM_PER_MIN = 300
/**
 * Fastest fill feed a pattern uses by default (mm/min). Faster frames (Falcon 2
 * at 25 000) can go higher through the `maxFeedMmPerMin` option; the overscan grows with v².
 */
export const DEFAULT_FEED_CAP_MM_PER_MIN = 12000
/** Lowest S fraction a pattern uses by default: above the dead zone and the knee of a diode curve. */
export const DEFAULT_MIN_POWER_FRACTION = 0.15

export interface PatternContext {
  machine: MachineProfile
  material: MaterialProfile
  /** Usable bed: the machine's travel, and the frame's work area when it is a catalog frame. */
  bedMm: { x: number; y: number }
}

export interface ContextOptions {
  /** Override the bed (mm), e.g. a smaller material sheet. Clamped to the machine's travel. */
  bedMm?: { x: number; y: number }
}

export function patternContext(machine: MachineProfile, material: MaterialProfile, options: ContextOptions = {}): PatternContext {
  let x = machine.travelMm.x
  let y = machine.travelMm.y
  const frame = machine.frameId ? findFrame(machine.frameId) : undefined
  if (frame) {
    x = Math.min(x, frame.workAreaMm.x)
    y = Math.min(y, frame.workAreaMm.y)
  }
  if (options.bedMm) {
    x = Math.min(x, options.bedMm.x)
    y = Math.min(y, options.bedMm.y)
  }
  return { machine, material, bedMm: { x, y } }
}

export function machineInfo(ctx: PatternContext): PatternMachineInfo {
  const m = ctx.machine
  return {
    name: m.name,
    ...(m.frameId ? { frameId: m.frameId } : {}),
    ...(m.moduleId ? { moduleId: m.moduleId } : {}),
    opticalPowerW: m.opticalPowerW,
    sMax: m.sMax,
    bedMm: { ...ctx.bedMm },
  }
}

/** Optical power (W) at a power fraction of $30, through the module's curve. */
export const powerAt = (ctx: PatternContext, fraction: number): number =>
  ctx.machine.opticalPowerW * interpolateCurve(ctx.machine.powerCurve, Math.min(1, Math.max(0, fraction)))

/**
 * The smallest power fraction that gives `watts`, on the rising part of the
 * curve. Null when the module can't reach it.
 */
export function fractionForPower(ctx: PatternContext, watts: number): number | null {
  const c = ctx.machine.powerCurve
  const target = watts / ctx.machine.opticalPowerW
  if (target > c[c.length - 1]!.power + 1e-12) return null
  if (target <= 0) return 0
  for (let i = 1; i < c.length; i++) {
    const a = c[i - 1]!
    const b = c[i]!
    if (b.power >= target && b.power > a.power) return a.s + ((target - a.power) / (b.power - a.power)) * (b.s - a.s)
  }
  return 1
}

/** S rounded the way the G-code writes it (0.1 S unit), as a fraction of $30. */
export function roundS(ctx: PatternContext, fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * ctx.machine.sMax * 10) / 10
}

/** Feed limit along a scan axis (mm/min). */
export const axisRate = (ctx: PatternContext, axis: ScanAxis): number => ctx.machine.maxRateMmPerMin[axis]

/** Distance the head needs to reach `feed` from rest along an axis, with margin (mm). */
export function overscanMm(ctx: PatternContext, feedMmPerMin: number, axis: ScanAxis): number {
  const v = feedMmPerMin / 60
  const a = ctx.machine.accelMmPerS2[axis]
  return Math.ceil(((v * v) / (2 * a)) * 1.15 * 10 + 5) / 10
}

/** Fastest fill feed for an axis: the machine's rate, capped. */
export const fillFeedCap = (ctx: PatternContext, axis: ScanAxis, cap = DEFAULT_FEED_CAP_MM_PER_MIN): number =>
  Math.max(MIN_FEED_MM_PER_MIN, Math.min(axisRate(ctx, axis), cap))

/** Minor spot sigma across a stroke (mm); the spot is aligned or not, the narrow axis is a fair line width. */
export const strokeSigmaMm = (ctx: PatternContext): number => Math.min(ctx.machine.spot.sigmaXMm, ctx.machine.spot.sigmaYMm)

/** Spot 1/e² diameter on its narrow axis (mm). */
export const spotDiameterMm = (ctx: PatternContext): number => 4 * strokeSigmaMm(ctx)

/** A default line interval: a little under the narrow spot diameter, on a 0.005 mm step. */
export function defaultIntervalMm(ctx: PatternContext): number {
  return Math.max(0.02, Math.round((spotDiameterMm(ctx) * 0.8) / 0.005) * 0.005)
}

/**
 * The material's useful range as incident fluence (J/mm²): under below `lo`,
 * over above `hi`. The material thresholds are on absorbed fluence.
 */
export function materialRange(ctx: PatternContext): { lo: number; hi: number } {
  const t = verdictThresholds(ctx.material.response)
  const a = Math.max(0.01, ctx.material.absorption)
  const lo = Math.max(1e-3, t.underBelow / a)
  return { lo, hi: Math.max(lo * 1.5, t.overAbove / a) }
}

/** Geometric middle of the material's range (incident J/mm²). */
export const materialMid = (ctx: PatternContext): number => {
  const { lo, hi } = materialRange(ctx)
  return Math.sqrt(lo * hi)
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** Settings for a raster fill at a power fraction and feed. */
export function fillSettings(ctx: PatternContext, fraction: number, feedMmPerMin: number, intervalMm: number, scan: ScanAxis): CellSettings {
  const s = roundS(ctx, fraction)
  const powerW = powerAt(ctx, s / ctx.machine.sMax)
  const feed = Math.round(feedMmPerMin)
  return {
    op: 'fill',
    laser: 'm4',
    s,
    powerPct: round3((s / ctx.machine.sMax) * 100),
    powerW: round3(powerW),
    feedMmPerMin: feed,
    intervalMm: round3(intervalMm),
    scan,
    energyJPerMm2: round3(powerW / ((feed / 60) * intervalMm)),
  }
}

/** Settings for vector strokes at a power fraction and feed. */
export function lineSettings(ctx: PatternContext, fraction: number, feedMmPerMin: number): CellSettings {
  const s = roundS(ctx, fraction)
  const powerW = powerAt(ctx, s / ctx.machine.sMax)
  const feed = Math.round(feedMmPerMin)
  const perMm = powerW / (feed / 60)
  return {
    op: 'line',
    laser: 'm4',
    s,
    powerPct: round3((s / ctx.machine.sMax) * 100),
    powerW: round3(powerW),
    feedMmPerMin: feed,
    energyJPerMm2: round3(perMm / (Math.sqrt(2 * Math.PI) * strokeSigmaMm(ctx))),
    lineEnergyJPerMm: Math.round(perMm * 1e5) / 1e5,
  }
}

/**
 * Power fraction and feed that give `energy` with `width` mm swept per mm of
 * travel: at `feed` when the power for it lies between the default minimum and
 * full power; otherwise the feed moves (slower for more energy, faster for less,
 * within MIN_FEED and `maxFeed`) and the power is clamped.
 */
function solveForEnergy(ctx: PatternContext, energy: number, feedMmPerMin: number, width: number, maxFeed: number): [number, number] {
  const need = (f: number) => energy * (f / 60) * width
  const pMax = ctx.machine.opticalPowerW
  const pMin = powerAt(ctx, DEFAULT_MIN_POWER_FRACTION)
  let feed = feedMmPerMin
  if (need(feed) > pMax) feed = Math.max(MIN_FEED_MM_PER_MIN, (pMax / (energy * width)) * 60)
  else if (need(feed) < pMin) feed = Math.min(Math.max(feed, maxFeed), (pMin / (energy * width)) * 60)
  const fraction = Math.max(DEFAULT_MIN_POWER_FRACTION, fractionForPower(ctx, Math.min(need(feed), pMax)) ?? 1)
  return [fraction, feed]
}

/** The fill nearest `feed` that gives `energy` (incident J/mm²) at this interval. */
export function fillForEnergy(ctx: PatternContext, energy: number, feedMmPerMin: number, intervalMm: number, scan: ScanAxis): CellSettings {
  const [fraction, feed] = solveForEnergy(ctx, energy, feedMmPerMin, intervalMm, fillFeedCap(ctx, scan))
  return fillSettings(ctx, fraction, feed, intervalMm, scan)
}

/** Stroke settings nearest `feed` whose centre-line energy is `energy` (incident J/mm²). */
export function lineForEnergy(ctx: PatternContext, energy: number, feedMmPerMin: number): CellSettings {
  const width = Math.sqrt(2 * Math.PI) * strokeSigmaMm(ctx)
  const [fraction, feed] = solveForEnergy(ctx, energy, feedMmPerMin, width, Math.min(axisRate(ctx, 'x'), axisRate(ctx, 'y'), feedMmPerMin * 4))
  return lineSettings(ctx, fraction, feed)
}

/** Label strokes: a full mark (the top of the material's range) at a moderate feed, so thin strokes read. */
export function labelSettings(ctx: PatternContext): CellSettings {
  const feed = Math.min(1500, axisRate(ctx, 'x'), axisRate(ctx, 'y'))
  return lineForEnergy(ctx, materialRange(ctx).hi, feed)
}

// SPDX-License-Identifier: MIT
// Thermal step (COD-258, core-internal, plain TS): normative rules for the
// `peakTemperature` thermal model (Option B). The CPU reference is
// src/sim/thermal.ts, the WebGL2 path src/sim/gl/gl-thermal.ts.
//
// Why two scales. A 450 nm diode spot (σ ≈ 0.015 × 0.03 mm) crosses a point
// in well under a millisecond, while heat from neighbouring lines arrives over
// tens of milliseconds to seconds. Linear conduction with the COD-266
// constants puts the flash of a normal engrave at ~10⁴ K: real surfaces are
// capped there by pyrolysis and ablation, which no published constant
// describes. So the model splits the surface temperature where a sample lands
// at the lag τ = lagBins · binS:
//
//   T_peak,i = T_ambient + ΔT_bulk,i + ΔT_flash,i
//
//   ΔT_bulk   heat older than τ, from a coarse thermal grid (physical k, ρc):
//             THERMAL_LAYERS depth layers per cell, lateral diffusion as an exact
//             Gaussian step per bin, depth diffusion implicit per column.
//   ΔT_flash  the pass itself (heat younger than τ): the moving-Gaussian-source
//             integral on a semi-infinite solid gives how the flash per unit
//             centre-line fluence varies with speed and direction (flashSpeedFactor,
//             1 at referenceSpeedMmPerS along +X). Its absolute scale is
//             calibrated, not physical: flashKPerJPerMm2 = (rampOnsetK − ambientK)
//             ÷ rampStart, so a reference pass reaches rampOnsetK exactly where the
//             fluence-fitted ramp starts.
//
// The response then runs on thermal dose instead of fluence: each sample's
// absorbed energy is weighted by
//
//   w_i = T_rise,i / (flashKPerJPerMm2 · F_centre,i)
//       = flashSpeedFactor(v_i, φ_i) + ΔT_bulk,i · v_i · √(2π) · σ⊥(φ_i) / (flashKPerJPerMm2 · a_i · P_i)
//
// where F_centre = a·P / (v · √(2π) · σ⊥) is the centre-line fluence of the
// pass (σ⊥ across the motion, from the blur kernel's covariance). Dose equals
// fluence for a cold reference pass; slower passes at the same fluence get less,
// preheated material more. Dose goes through the same deposit and blur as
// fluence, so every fluence threshold of the response kinds applies to dose.
//
// Per-sample weights depend only on earlier samples, so they are computed once
// per job and stay valid at every scrub cutoff.
//
// Rules (normative):
//   - Thermal grid: burn bounds + THERMAL_MARGIN_MM, pitch THERMAL_PITCH_MM,
//     coarsened so it stays within THERMAL_MAX_CELLS; lattice-aligned origin.
//     Excess temperature (K over ambient) per layer; insulated top, bottom and
//     sides (mirror boundary), so Σ ρc · ΔT · volume equals the absorbed energy
//     injected.
//   - Layers: top thickness THERMAL_TOP_LAYER_PER_PITCH · pitch, each next one
//     THERMAL_LAYER_RATIO times thicker.
//   - Time bins of binS = max(THERMAL_BIN_S, duration ÷ maxBins), where
//     maxBins = min(THERMAL_MAX_BINS, THERMAL_MAX_CELL_BINS ÷ thermal cells) bounds
//     the GPU work of very long jobs; sample
//     i is in bin floor(t_i / binS). lagBins = max(1, round(THERMAL_NEAR_S / binS)).
//     For bin k, in order: gather bin k; inject bin k − lagBins; gather bin k
//     again; diffuse by binS. Runs of empty bins diffuse as one step.
//     Injection: absorbed energy, bilinear, split over the layers as a
//     half-Gaussian of σ_z = √(2ατ), then spread laterally by
//     gaussianTaps(injectSpreadCells2), variance (2ατ − pitch²/3) / pitch² (the
//     bilinear inject and read each add pitch²/6), because heat injected at age τ
//     has already diffused that far. Dose goes to the accumulated-dose grid,
//     bilinear, unspread.
//     A gather reads ΔT_bulk from the top layer and the accumulated dose (char
//     level for absorption feedback), both bilinearly. Each sample blends its two gathers by its
//     fraction f = t_i / binS − k through the bin: early samples should not yet
//     see the lagged bin, late ones all of it (without this, slow moves bead at
//     v · binS).
//   - Absorption feedback (char kind, absorptionAtFullChar set):
//     a_i = absorption + (absorptionAtFullChar − absorption) · rampT(dose_acc,i), where
//     dose_acc is the thermal grid's accumulated dose (J/mm², no diffusion).
//   - Bulk temperature output: per thermal cell, the highest ΔT_bulk any sample
//     in it gathered; fireRisk.kind = temperature compares ambient + that.
//   - Peak temperature output: ambient + flashKPerJPerMm2 · dose, the
//     single-pass peak surface temperature equivalent to the cell's dose.

import type { BoundsMm } from './common.ts'
import type { GridSpec, KernelSigma } from './deposit.ts'
import type { Spot } from './machine.ts'
import { verdictThresholds, type MaterialProfile, type MaterialResponse, type ThermalModel } from './material.ts'
import { UNTOUCHED_FRACTION, Verdict } from './outputs.ts'

export type PeakTemperatureModel = Extract<ThermalModel, { kind: 'peakTemperature' }>

export const THERMAL_PITCH_MM = 0.1
export const THERMAL_MAX_CELLS = 256 * 256
export const THERMAL_MARGIN_MM = 1
export const THERMAL_BIN_S = 0.01
export const THERMAL_MAX_BINS = 1024
/** Work budget: thermal cells × bins (each bin is two passes over the grid). */
export const THERMAL_MAX_CELL_BINS = 2 ** 29
export const THERMAL_NEAR_S = 0.02
export const THERMAL_LAYERS = 4
export const THERMAL_LAYER_RATIO = 4
export const THERMAL_TOP_LAYER_PER_PITCH = 0.25
/** Speeds below this are treated as this for the flash (stops, corners). */
export const THERMAL_MIN_SPEED_MM_PER_S = 1

export const thermalDiffusivity = (t: PeakTemperatureModel): number => t.conductivityWPerMmK / t.volumetricHeatCapacityJPerMm3K

export interface ThermalPlanOptions {
  /** Overrides for convergence tests. */
  pitchMm?: number
  binS?: number
  nearS?: number
}

export interface ThermalPlan {
  grid: GridSpec
  binS: number
  lagBins: number
  /** lagBins · binS: heat younger than this is the flash, older is bulk. */
  nearS: number
  /** Bins covering [0, last sample]. */
  binCount: number
  alphaMm2PerS: number
  layerMm: number[]
  /** Fraction of injected energy per layer (sums to 1). */
  injectFraction: number[]
  /** Lateral spread (variance, cells²) given to injected heat; 0 = none. */
  injectSpreadCells2: number
}

export function planThermal(
  burnBounds: BoundsMm,
  lastSampleS: number,
  durationS: number,
  thermal: PeakTemperatureModel,
  options: ThermalPlanOptions = {},
): ThermalPlan {
  const m = THERMAL_MARGIN_MM
  const spanX = burnBounds.maxXMm - burnBounds.minXMm + 2 * m
  const spanY = burnBounds.maxYMm - burnBounds.minYMm + 2 * m
  const pitchMm = options.pitchMm ?? Math.max(THERMAL_PITCH_MM, Math.sqrt((spanX * spanY) / THERMAL_MAX_CELLS) * 1.01)
  const originXMm = Math.floor((burnBounds.minXMm - m) / pitchMm) * pitchMm
  const originYMm = Math.floor((burnBounds.minYMm - m) / pitchMm) * pitchMm
  const width = Math.max(1, Math.ceil((burnBounds.maxXMm + m - originXMm) / pitchMm))
  const height = Math.max(1, Math.ceil((burnBounds.maxYMm + m - originYMm) / pitchMm))
  const maxBins = Math.max(1, Math.min(THERMAL_MAX_BINS, Math.floor(THERMAL_MAX_CELL_BINS / (width * height))))
  const binS = options.binS ?? Math.max(THERMAL_BIN_S, durationS / maxBins)
  const lagBins = Math.max(1, Math.round((options.nearS ?? THERMAL_NEAR_S) / binS))
  const nearS = lagBins * binS
  const alpha = thermalDiffusivity(thermal)
  const layerMm: number[] = []
  for (let k = 0; k < THERMAL_LAYERS; k++) layerMm.push(THERMAL_TOP_LAYER_PER_PITCH * pitchMm * THERMAL_LAYER_RATIO ** k)
  const sigmaZ = Math.sqrt(2 * alpha * nearS)
  const injectFraction: number[] = []
  let z = 0
  for (let k = 0; k < THERMAL_LAYERS; k++) {
    const z1 = z + layerMm[k]!
    injectFraction.push(k === THERMAL_LAYERS - 1 ? 1 - erf(z / (Math.SQRT2 * sigmaZ)) : erf(z1 / (Math.SQRT2 * sigmaZ)) - erf(z / (Math.SQRT2 * sigmaZ)))
    z = z1
  }
  const gather2 = Math.max(0, (2 * alpha * nearS) / (pitchMm * pitchMm) - 1 / 3)
  return {
    grid: { originXMm, originYMm, pitchMm, width, height },
    binS,
    lagBins,
    nearS,
    binCount: Math.floor(lastSampleS / binS) + 1,
    alphaMm2PerS: alpha,
    layerMm,
    injectFraction,
    injectSpreadCells2: gather2,
  }
}

/** Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7). */
export function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}

/** Lateral diffusion step: 1D taps of a Gaussian with variance 2α·dt (cells²), normalised. */
export function diffusionTaps(alphaMm2PerS: number, dtS: number, pitchMm: number): Float32Array {
  return gaussianTaps((2 * alphaMm2PerS * dtS) / (pitchMm * pitchMm))
}

/** 1D taps of a normalised Gaussian of variance v (cells²). */
export function gaussianTaps(v: number): Float32Array {
  // Exact variance for small steps, where a sampled Gaussian would be too narrow.
  if (v <= 0.5) return Float32Array.of(v / 2, 1 - v, v / 2)
  const sigma = Math.sqrt(v)
  const r = Math.ceil(3 * sigma)
  const w = new Float64Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += w[i + r] = Math.exp(-(i * i) / (2 * v))
  return Float32Array.from(w, (x) => x / sum)
}

/** Mirror index into [0, n): the insulated-boundary fold used by every lateral pass. */
export function mirrorIndex(i: number, n: number): number {
  const p = 2 * n
  let m = i % p
  if (m < 0) m += p
  return m < n ? m : p - 1 - m
}

/**
 * Implicit (backward Euler) depth step of one column over THERMAL_LAYERS
 * layers, insulated top and bottom. The matrix depends only on dt, so the
 * Thomas elimination is done once here and `solve` is a forward and back sweep.
 * Per unit area: capacity d_k (× ρc, which cancels), conductance α ÷ centre distance.
 */
export interface DepthSolver {
  /** Right-hand-side scale d_k / dt. */
  cap: Float64Array
  /** Eliminated sub-diagonal multipliers m_k, diagonal b_k and super-diagonal c_k. */
  m: Float64Array
  b: Float64Array
  c: Float64Array
}

export function depthSolver(layerMm: readonly number[], alphaMm2PerS: number, dtS: number): DepthSolver {
  const n = layerMm.length
  const cap = new Float64Array(n)
  const m = new Float64Array(n)
  const b = new Float64Array(n)
  const c = new Float64Array(n)
  const a = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const gUp = k > 0 ? alphaMm2PerS / ((layerMm[k - 1]! + layerMm[k]!) / 2) : 0
    const gDown = k < n - 1 ? alphaMm2PerS / ((layerMm[k]! + layerMm[k + 1]!) / 2) : 0
    cap[k] = layerMm[k]! / dtS
    a[k] = -gUp
    b[k] = cap[k]! + gUp + gDown
    c[k] = -gDown
  }
  for (let k = 1; k < n; k++) {
    m[k] = a[k]! / b[k - 1]!
    b[k] = b[k]! - m[k]! * c[k - 1]!
  }
  return { cap, m, b, c }
}

/** Solve one column in place with a prepared solver. */
export function depthStep(column: Float64Array | Float32Array, solver: DepthSolver): void {
  const { cap, m, b, c } = solver
  const n = cap.length
  const d = column
  d[0] = cap[0]! * d[0]!
  for (let k = 1; k < n; k++) d[k] = cap[k]! * d[k]! - m[k]! * d[k - 1]!
  d[n - 1] = d[n - 1]! / b[n - 1]!
  for (let k = n - 2; k >= 0; k--) d[k] = (d[k]! - c[k]! * d[k + 1]!) / b[k]!
}

/** The ramp start (J/mm²) of a response kind: where darkening, frosting or marking begins. */
export function rampStartJPerMm2(response: MaterialResponse): number {
  switch (response.kind) {
    case 'char':
      return response.toneStartJPerMm2
    case 'melt':
      return response.frostStartJPerMm2
    case 'bleach':
      return response.markStartJPerMm2
  }
}

/** Flash rise per unit centre-line dose at the reference speed (K per J/mm²). */
export function flashKPerJPerMm2(material: Pick<MaterialProfile, 'response'>, thermal: PeakTemperatureModel): number {
  return (thermal.rampOnsetK - thermal.ambientK) / Math.max(rampStartJPerMm2(material.response), 1e-9)
}

/** 2×2 covariance [a, c; c, b] of a Gaussian with σ along (u, v) rotated by angleDeg. */
export function covariance(sigmaUMm: number, sigmaVMm: number, angleDeg: number): [a: number, b: number, c: number] {
  const r = (angleDeg * Math.PI) / 180
  const co = Math.cos(r)
  const si = Math.sin(r)
  const u2 = sigmaUMm * sigmaUMm
  const v2 = sigmaVMm * sigmaVMm
  return [u2 * co * co + v2 * si * si, u2 * si * si + v2 * co * co, (u2 - v2) * co * si]
}

/** σ of a covariance across a motion direction φ (rad): √(nᵀΣn), n = (−sin φ, cos φ). */
export function sigmaAcross(cov: readonly [number, number, number], phi: number): number {
  const s = Math.sin(phi)
  const c = Math.cos(phi)
  return Math.sqrt(cov[0] * s * s + cov[1] * c * c - 2 * cov[2] * s * c)
}

/**
 * Peak surface rise per absorbed watt (K/W) on the centre line of a Gaussian
 * spot (covariance `spot`) moving at v along φ over a semi-infinite solid,
 * counting only heat younger than windowS:
 *   ΔT(t) = 1/(ρc√(πα)) ∫₀^W s^-½ N₂(v(t − s)·d̂; Σ + 2αs·I) ds,  maximised over t.
 */
export function flashRisePerW(
  spot: readonly [number, number, number],
  speedMmPerS: number,
  phi: number,
  alphaMm2PerS: number,
  heatCapacityJPerMm3K: number,
  windowS: number,
): number {
  const [sa, sb, sc] = spot
  const dx = Math.cos(phi)
  const dy = Math.sin(phi)
  const N = 400
  // s = W·u⁴ concentrates nodes near s = 0 and removes the s^-½ singularity.
  const us = new Float64Array(N + 1)
  const gs = new Float64Array(N + 1)
  const qs = new Float64Array(N + 1)
  for (let j = 0; j <= N; j++) {
    const u = j / N
    const s = windowS * u ** 4
    const e = 2 * alphaMm2PerS * s
    const det = (sa + e) * (sb + e) - sc * sc
    us[j] = s
    gs[j] = u / (2 * Math.PI * Math.sqrt(det))
    qs[j] = (dx * dx * (sb + e) - 2 * dx * dy * sc + dy * dy * (sa + e)) / det
  }
  const v = speedMmPerS
  const rise = (t: number) => {
    let acc = 0
    for (let j = 0; j <= N; j++) {
      const d = v * (t - us[j]!)
      const f = gs[j]! * Math.exp(-0.5 * d * d * qs[j]!)
      acc += j === 0 || j === N ? f / 2 : f
    }
    return (acc / N) * 4 * Math.sqrt(windowS)
  }
  const sigmaT = 1 / (Math.sqrt(qs[0]!) * v)
  const tMax = Math.min(windowS, 8 * sigmaT)
  let best = 0
  let bestT = 0
  const M = 32
  for (let j = 0; j <= M; j++) {
    const t = (tMax * j) / M
    const r = rise(t)
    if (r > best) {
      best = r
      bestT = t
    }
  }
  // Golden-section refinement around the best grid point.
  let lo = Math.max(0, bestT - tMax / M)
  let hi = Math.min(tMax, bestT + tMax / M)
  const g = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 24; i++) {
    const m1 = hi - g * (hi - lo)
    const m2 = lo + g * (hi - lo)
    if (rise(m1) > rise(m2)) hi = m2
    else lo = m1
  }
  best = Math.max(best, rise((lo + hi) / 2))
  return best / (heatCapacityJPerMm3K * Math.sqrt(Math.PI * alphaMm2PerS))
}

/** Speed × direction table of the flash factor (1 at the reference speed along +X). */
export interface FlashTable {
  logSpeedMin: number
  logSpeedStep: number
  speedCount: number
  /** Directions 0..π inclusive. */
  angleCount: number
  /** [angle][speed], row-major. */
  factor: Float32Array
  /** Covariance of the blur kernel (spot ⊕ heat spread), for σ⊥. */
  kernelCov: [number, number, number]
}

export const FLASH_TABLE_SPEEDS: [minMmPerS: number, maxMmPerS: number, count: number] = [THERMAL_MIN_SPEED_MM_PER_S, 5000, 48]
export const FLASH_TABLE_ANGLES = 13

export function flashTable(spot: Spot, kernel: KernelSigma, thermal: PeakTemperatureModel, windowS: number): FlashTable {
  const spotCov = covariance(spot.sigmaXMm, spot.sigmaYMm, spot.angleDeg)
  const kernelCov = covariance(kernel.sigmaUMm, kernel.sigmaVMm, kernel.angleDeg)
  const alpha = thermalDiffusivity(thermal)
  const [vMin, vMax, nv] = FLASH_TABLE_SPEEDS
  const logSpeedMin = Math.log(vMin)
  const logSpeedStep = (Math.log(vMax) - logSpeedMin) / (nv - 1)
  // Per unit centre-line fluence: rise/W × v · √(2π) · σ⊥ (the a·P cancels).
  const perDose = (v: number, phi: number) =>
    flashRisePerW(spotCov, v, phi, alpha, thermal.volumetricHeatCapacityJPerMm3K, windowS) * v * Math.sqrt(2 * Math.PI) * sigmaAcross(kernelCov, phi)
  const ref = perDose(thermal.referenceSpeedMmPerS, 0)
  const factor = new Float32Array(FLASH_TABLE_ANGLES * nv)
  for (let a = 0; a < FLASH_TABLE_ANGLES; a++) {
    const phi = (Math.PI * a) / (FLASH_TABLE_ANGLES - 1)
    // A Gaussian spot is symmetric under a half turn, so φ = π repeats φ = 0.
    if (a === FLASH_TABLE_ANGLES - 1) {
      factor.copyWithin(a * nv, 0, nv)
      continue
    }
    for (let j = 0; j < nv; j++) factor[a * nv + j] = perDose(Math.exp(logSpeedMin + j * logSpeedStep), phi) / ref
  }
  return { logSpeedMin, logSpeedStep, speedCount: nv, angleCount: FLASH_TABLE_ANGLES, factor, kernelCov }
}

/** Bilinear lookup in (log speed, direction); direction φ in radians, any sign. */
export function flashSpeedFactor(table: FlashTable, speedMmPerS: number, phi: number): number {
  const fv = Math.min(table.speedCount - 1, Math.max(0, (Math.log(Math.max(speedMmPerS, 1e-9)) - table.logSpeedMin) / table.logSpeedStep))
  let p = phi % Math.PI
  if (p < 0) p += Math.PI
  const fa = (p / Math.PI) * (table.angleCount - 1)
  const v0 = Math.min(table.speedCount - 2, Math.floor(fv))
  const a0 = Math.min(table.angleCount - 2, Math.floor(fa))
  const tv = fv - v0
  const ta = fa - a0
  const n = table.speedCount
  const f = table.factor
  const lo = f[a0 * n + v0]! * (1 - tv) + f[a0 * n + v0 + 1]! * tv
  const hi = f[(a0 + 1) * n + v0]! * (1 - tv) + f[(a0 + 1) * n + v0 + 1]! * tv
  return lo * (1 - ta) + hi * ta
}

/** Verdict from thermal dose and bulk temperature (classifyFluence's thermal twin). */
export function classifyThermal(
  material: Pick<MaterialProfile, 'response' | 'fireRisk'>,
  doseJPerMm2: number,
  bulkTemperatureK: number,
): Verdict {
  const { underBelow, overAbove } = verdictThresholds(material.response)
  const fire = material.fireRisk
  if (fire.kind === 'temperature' && bulkTemperatureK >= fire.thresholdK) return Verdict.FireRisk
  if (fire.kind === 'fluence' && doseJPerMm2 >= fire.thresholdJPerMm2) return Verdict.FireRisk
  if (doseJPerMm2 > overAbove) return Verdict.Over
  if (doseJPerMm2 >= underBelow) return Verdict.InRange
  if (doseJPerMm2 > UNTOUCHED_FRACTION * underBelow) return Verdict.Under
  return Verdict.Untouched
}

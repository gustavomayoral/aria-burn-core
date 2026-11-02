// Deposit input: sample stream → fluence grid (core-internal, plain TS).
//
// Rules (normative):
//   - Fluence is J/mm² on a regular grid. Cell (i, j) covers
//     [originX + i·pitch, originX + (i+1)·pitch) × [originY + j·pitch, …);
//     its centre is the sample point for bilinear weights. Row-major, row 0 = min Y.
//   - Grid pitch = minor spot sigma ÷ 3 (GRID_PITCH_PER_SIGMA).
//   - Each sample deposits E = powerW · dtS · absorption (J), split bilinearly
//     over the four nearest cell centres, adding w·E / pitch² to each.
//   - Spot and heat spread are one linear blur after deposit:
//     σ_total = √(σ_spot² + σ_heat²) per spot axis, rotated by spot.angleDeg.
//     σ_heat is isotropic. The kernel is truncated at KERNEL_RADIUS_SIGMAS and
//     normalised by its discrete sum, so blur conserves Σ fluence · pitch².
//   - Conservation: Σ cell · pitch² equals Σ E within 1% after deposit and after
//     each blur pass (COD-252 pass criterion).

import type { Spot } from './machine.ts'

export const GRID_PITCH_PER_SIGMA = 1 / 3
export const KERNEL_RADIUS_SIGMAS = 3
export const CONSERVATION_TOLERANCE = 0.01

export function gridPitchMm(spot: Spot): number {
  return Math.min(spot.sigmaXMm, spot.sigmaYMm) * GRID_PITCH_PER_SIGMA
}

export interface KernelSigma {
  /** Along the rotated spot X axis (mm). */
  sigmaUMm: number
  /** Along the rotated spot Y axis (mm). */
  sigmaVMm: number
  angleDeg: number
}

export function kernelSigma(spot: Spot, sigmaHeatMm: number): KernelSigma {
  const h2 = sigmaHeatMm * sigmaHeatMm
  return {
    sigmaUMm: Math.sqrt(spot.sigmaXMm ** 2 + h2),
    sigmaVMm: Math.sqrt(spot.sigmaYMm ** 2 + h2),
    angleDeg: spot.angleDeg,
  }
}

/** Kernel reach in mm; the margin every grid and tile carries around burned area. */
export function kernelRadiusMm(kernel: KernelSigma): number {
  return KERNEL_RADIUS_SIGMAS * Math.max(kernel.sigmaUMm, kernel.sigmaVMm)
}

export interface GridSpec {
  /** Lower-left corner of cell (0, 0), absolute mm. */
  originXMm: number
  originYMm: number
  pitchMm: number
  width: number
  height: number
}

export interface FluenceGrid extends GridSpec {
  /** J/mm², length width × height, row-major, row 0 = min Y. */
  data: Float32Array
}

export interface DepositInput {
  grid: GridSpec
  kernel: KernelSigma
  /** MaterialProfile.absorption. */
  absorption: number
  /** Samples with t0S + tRelS > cutoff are skipped (scrub). Infinity for the full job. */
  timeCutoffS: number
}

export interface DepositResult {
  fluence: FluenceGrid
  /** Σ powerW · dtS · absorption over accepted samples (J). */
  expectedEnergyJ: number
  /** Energy of samples that fell outside the grid (J); non-zero means the grid or tile margin is wrong. */
  clippedEnergyJ: number
}

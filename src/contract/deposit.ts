// SPDX-License-Identifier: MIT
// Deposit input: sample stream → fluence grid (core-internal, plain TS).
//
// Rules (normative):
//   - Fluence is J/mm² on a regular grid. Cell (i, j) covers
//     [originX + i·pitch, originX + (i+1)·pitch) × [originY + j·pitch, …);
//     its centre is the sample point for bilinear weights. Row-major, row 0 = min Y.
//   - Detail pitch = minor spot sigma ÷ 3 (GRID_PITCH_PER_SIGMA). The job grid
//     uses an integer multiple of it under a cell budget (tiling.ts, BURN-37);
//     a coarser job grid blurs with coarsePitchKernel.
//   - Each sample deposits E = powerW · dtS · absorption (J), split bilinearly
//     over the four nearest cell centres, adding w·E / pitch² to each.
//   - Spot and heat spread are one linear blur after deposit:
//     σ_total = √(σ_spot² + σ_heat²) per spot axis, rotated by spot.angleDeg.
//     σ_heat is isotropic. The kernel is truncated at KERNEL_RADIUS_SIGMAS and
//     normalised by its discrete sum, so blur conserves Σ fluence · pitch².
//   - The blur is a pass along machine X then a sheared pass along Y
//     (shearedKernel). Axis-aligned spots have shear 0, a plain separable blur.
//     For a rotated spot the Y pass at row offset t reads at x + shear·t,
//     linearly interpolated, which restores the X–Y correlation; the X pass
//     σ is reduced by the interpolation's variance. Each pass sums to 1.
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

/**
 * The blur kernel for a job grid coarser than the detail pitch (BURN-37). The
 * bilinear deposit spreads each sample over a pitch-wide tent, adding pitch²/6
 * of variance per axis, so a coarser grid blurs more. The job grid's kernel
 * gives back the difference, (pitch² − detailPitch²)/6 per axis (isotropic, so
 * it holds for rotated spots), and both grids show the same line width. At
 * k = 1 the kernel is unchanged.
 */
export function coarsePitchKernel(kernel: KernelSigma, pitchMm: number, detailPitchMm: number): KernelSigma {
  const d = (pitchMm * pitchMm - detailPitchMm * detailPitchMm) / 6
  if (d <= 0) return kernel
  return {
    ...kernel,
    sigmaUMm: Math.sqrt(Math.max(kernel.sigmaUMm ** 2 - d, 0)),
    sigmaVMm: Math.sqrt(Math.max(kernel.sigmaVMm ** 2 - d, 0)),
  }
}

/**
 * The kernel's covariance [[a, c], [c, b]] in machine axes, split as an X
 * Gaussian (σx² = a − c²/b) followed by a Y Gaussian (σy² = b) sheared by
 * c / b cells of X per cell of Y.
 */
export interface ShearedKernel {
  sigmaXMm: number
  sigmaYMm: number
  /** X offset per unit Y offset (mm/mm). 0 for axis-aligned kernels. */
  shear: number
}

export function shearedKernel(kernel: KernelSigma): ShearedKernel {
  const r = (kernel.angleDeg * Math.PI) / 180
  const c2 = Math.cos(r) ** 2
  const s2 = Math.sin(r) ** 2
  const u2 = kernel.sigmaUMm ** 2
  const v2 = kernel.sigmaVMm ** 2
  const a = u2 * c2 + v2 * s2
  const b = u2 * s2 + v2 * c2
  // Multiples of 90° and round kernels are axis-aligned; snap the float noise of cos(90°) to exactly 0.
  if (Math.min(c2, s2) < 1e-9 || Math.abs(u2 - v2) < 1e-15) return { sigmaXMm: Math.sqrt(a), sigmaYMm: Math.sqrt(b), shear: 0 }
  const c = (u2 - v2) * Math.cos(r) * Math.sin(r)
  return { sigmaXMm: Math.sqrt(Math.max(0, a - (c * c) / b)), sigmaYMm: Math.sqrt(b), shear: c / b }
}

/**
 * Kernel reach in mm; the margin every grid and tile carries around burned area.
 * For a rotated kernel this is the sheared blur's X reach when that is larger.
 */
export function kernelRadiusMm(kernel: KernelSigma): number {
  const { sigmaXMm, sigmaYMm, shear } = shearedKernel(kernel)
  return KERNEL_RADIUS_SIGMAS * Math.max(kernel.sigmaUMm, kernel.sigmaVMm, sigmaXMm + Math.abs(shear) * sigmaYMm)
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

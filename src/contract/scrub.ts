// SPDX-License-Identifier: MIT
// Scrub (core-internal): timeline progress → time cutoff, coarse preview while
// dragging, full-resolution pass on release.
//
// Rules (normative):
//   - progress ∈ [0, 1] maps linearly to cutoffS = progress × plan.done durationS.
//     A sample deposits iff t0S + tRelS <= cutoffS.
//   - While dragging, the core runs on a coarse grid covering the same job grid:
//     coarse pitch = max(gridPitchMm, longer side / COARSE_MAX_CELLS). The kernel
//     widens to at least COARSE_MIN_SIGMA_CELLS coarse cells per axis so the blur
//     is resolved (no banding). Fluence is conserved: a coarse cell stores
//     energy / coarsePitch², and Σ cell · coarsePitch² matches full-res within 1%.
//   - On release, the full-resolution tiled pass runs at the same cutoff and
//     replaces the coarse result.
//   - Thermal (COD-258): the coarse path may approximate the thermal step; the
//     full pass on release runs it exactly.

import type { GridSpec, KernelSigma } from './deposit.ts'

export const COARSE_MAX_CELLS = 1024
export const COARSE_MIN_SIGMA_CELLS = 1

export type ScrubPhase = 'coarse' | 'full'

export interface ScrubRequest {
  progress: number
  phase: ScrubPhase
}

export function scrubCutoffS(progress: number, durationS: number): number {
  return Math.min(1, Math.max(0, progress)) * durationS
}

export function coarseGrid(grid: GridSpec): GridSpec {
  const sideMm = Math.max(grid.width, grid.height) * grid.pitchMm
  const pitchMm = Math.max(grid.pitchMm, sideMm / COARSE_MAX_CELLS)
  return {
    originXMm: grid.originXMm,
    originYMm: grid.originYMm,
    pitchMm,
    width: Math.max(1, Math.ceil((grid.width * grid.pitchMm) / pitchMm)),
    height: Math.max(1, Math.ceil((grid.height * grid.pitchMm) / pitchMm)),
  }
}

export function coarseKernel(kernel: KernelSigma, coarsePitchMm: number): KernelSigma {
  const min = COARSE_MIN_SIGMA_CELLS * coarsePitchMm
  return { ...kernel, sigmaUMm: Math.max(kernel.sigmaUMm, min), sigmaVMm: Math.max(kernel.sigmaVMm, min) }
}

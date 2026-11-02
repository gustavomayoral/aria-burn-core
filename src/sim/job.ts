// SPDX-License-Identifier: MIT
// Per-job simulation setup shared by the CPU reference and the WebGL2 path:
// pitch, kernel, job grid and tile plan from the contract rules.

import {
  coarseGrid,
  coarseKernel,
  gridPitchMm,
  kernelSigma,
  planJobGrid,
  planLiveTiles,
  planTiles,
  TILE_MAX_CELLS,
  type BoundsMm,
  type CellRect,
  type GridSpec,
  type KernelSigma,
  type MachineProfile,
  type MaterialProfile,
  type TilePlan,
} from '../contract/index.ts'
import { separableKernel, type SeparableKernel } from './kernel.ts'

export interface SimSetup {
  machine: MachineProfile
  material: MaterialProfile
  kernel: KernelSigma
  separable: SeparableKernel
  grid: GridSpec
  plan: TilePlan
}

export interface SetupOptions {
  /** Tile budget override (tests use small tiles to exercise seams). */
  maxTileCells?: number
  /** Pitch override (mm). Default is the contract's gridPitchMm (minor spot sigma ÷ 3). */
  pitchMm?: number
  /** 'live' anchors tiles to the absolute lattice (contract live.ts) so they stay put while a stream grows. */
  tiling?: 'regular' | 'live'
}

export function setupJob(
  burnBounds: BoundsMm,
  machine: MachineProfile,
  material: MaterialProfile,
  options: SetupOptions = {},
): SimSetup {
  const pitchMm = options.pitchMm ?? gridPitchMm(machine.spot)
  const kernel = kernelSigma(machine.spot, material.sigmaHeatMm)
  const grid = planJobGrid(burnBounds, pitchMm, kernel)
  const maxCells = options.maxTileCells ?? TILE_MAX_CELLS
  const plan = options.tiling === 'live' ? planLiveTiles(grid, kernel, maxCells) : planTiles(grid, kernel, maxCells)
  return { machine, material, kernel, separable: separableKernel(kernel, pitchMm), grid, plan }
}

/** The coarse scrub setup: same job area, coarse pitch, widened kernel, one tile. */
export function coarseSetup(full: SimSetup): SimSetup {
  const grid = coarseGrid(full.grid)
  const kernel = coarseKernel(full.kernel, grid.pitchMm)
  const whole = { x: 0, y: 0, width: grid.width, height: grid.height }
  const marginCells = Math.ceil(Math.max(kernel.sigmaUMm, kernel.sigmaVMm) * 3 / grid.pitchMm)
  return {
    ...full,
    kernel,
    separable: separableKernel(kernel, grid.pitchMm),
    grid,
    plan: { grid, marginCells, cols: 1, rows: 1, tiles: [{ col: 0, row: 0, core: whole, padded: whole }] },
  }
}

/** Grid spec of a sub-rectangle of the job grid. */
export function subGrid(grid: GridSpec, rect: CellRect): GridSpec {
  return {
    originXMm: grid.originXMm + rect.x * grid.pitchMm,
    originYMm: grid.originYMm + rect.y * grid.pitchMm,
    pitchMm: grid.pitchMm,
    width: rect.width,
    height: rect.height,
  }
}

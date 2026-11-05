// SPDX-License-Identifier: MIT
// Per-job simulation setup shared by the CPU reference and the WebGL2 path:
// pitch, kernel, job grid and tile plan from the contract rules.

import {
  coarseGrid,
  coarseKernel,
  coarsePitchKernel,
  gridPitchMm,
  jobPitchMm,
  kernelRadiusMm,
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
import type { ThermalPlanning, ThermalStep } from './thermal.ts'

export interface SimSetup {
  machine: MachineProfile
  material: MaterialProfile
  kernel: KernelSigma
  /** The full-resolution kernel; the thermal step uses it at every resolution (coarse scrub included). */
  thermalKernel: KernelSigma
  /** Overrides the default thermal step (contract thermal.ts, Option B) for materials with a thermal model. */
  thermalStep?: ThermalStep
  separable: SeparableKernel
  grid: GridSpec
  plan: TilePlan
  /** Burn bounds the grid was planned over. */
  burnBounds: BoundsMm
  /**
   * Pitch of the detail view and hover readout (mm): the contract's gridPitchMm
   * (or the override). `grid.pitchMm` is an integer multiple of it when the job
   * cell budget coarsened the job grid (BURN-37), else equal.
   */
  detailPitchMm: number
  /** How `plan` was made, so a smaller tile budget can rebuild it the same way (BURN-36). */
  tiling: 'regular' | 'live'
  /**
   * Thermal plan (BURN-35): 'live' while the job streams (set with live
   * tiling), so the thermal step continues over new samples instead of
   * rerunning; absent means 'job'.
   */
  thermalPlanning?: ThermalPlanning
}

export interface SetupOptions {
  /**
   * Padded tile side. Default TILE_MAX_CELLS (the hard cap); on the GPU run
   * the setup through GlSim.fit() so tiles fit the byte budget (BURN-36).
   * Tests use small tiles to exercise seams.
   */
  maxTileCells?: number
  /** Detail pitch override (mm). Default is the contract's gridPitchMm (minor spot sigma ÷ 3). */
  pitchMm?: number
  /**
   * Job cell budget (BURN-37): the job grid's pitch is the smallest integer
   * multiple of the detail pitch that fits it. Default Infinity (job pitch =
   * detail pitch, as on the CPU reference); on the GPU pass GlSim.cellBudget.
   */
  cellBudget?: number
  /** 'live' anchors tiles to the absolute lattice (contract live.ts) so they stay put while a stream grows. */
  tiling?: 'regular' | 'live'
  /** Thermal step override (e.g. an empirical speed correction in place of the peak-temperature grid). */
  thermalStep?: ThermalStep
}

export function setupJob(
  burnBounds: BoundsMm,
  machine: MachineProfile,
  material: MaterialProfile,
  options: SetupOptions = {},
): SimSetup {
  const detailPitchMm = options.pitchMm ?? gridPitchMm(machine.spot)
  const kernel = kernelSigma(machine.spot, material.sigmaHeatMm)
  const tiling = options.tiling ?? 'regular'
  // Live jobs size k from the bounds so far, so it steps up in whole multiples as they grow (contract tiling.ts, BURN-42).
  const pitchMm = jobPitchMm(burnBounds, detailPitchMm, kernel, options.cellBudget ?? Infinity)
  const grid = planJobGrid(burnBounds, pitchMm, kernel)
  const maxCells = options.maxTileCells ?? TILE_MAX_CELLS
  const plan = tiling === 'live' ? planLiveTiles(grid, kernel, maxCells) : planTiles(grid, kernel, maxCells)
  const setup: SimSetup = {
    machine,
    material,
    kernel,
    thermalKernel: kernel,
    // Margins use the full kernel; only the blur gives back the coarse deposit's spread (contract coarsePitchKernel).
    separable: separableKernel(coarsePitchKernel(kernel, pitchMm, detailPitchMm), pitchMm),
    grid,
    plan,
    burnBounds,
    detailPitchMm,
    tiling,
  }
  if (options.thermalStep) setup.thermalStep = options.thermalStep
  if (tiling === 'live') setup.thermalPlanning = 'live'
  return setup
}

const detailSetups = new WeakMap<SimSetup, SimSetup>()

/**
 * The setup at the detail pitch (BURN-37): the same job, grid planned over the
 * same bounds at `detailPitchMm`. It is what runDetail and the hover readout
 * use; only region runs touch it, so its plan is never budgeted. The setup
 * itself when the job grid was not coarsened.
 */
export function detailSetup(setup: SimSetup): SimSetup {
  if (setup.grid.pitchMm === setup.detailPitchMm) return setup
  let d = detailSetups.get(setup)
  if (!d) {
    const grid = planJobGrid(setup.burnBounds, setup.detailPitchMm, setup.kernel)
    d = {
      ...setup,
      separable: separableKernel(setup.kernel, setup.detailPitchMm),
      grid,
      plan: planTiles(grid, setup.kernel, TILE_MAX_CELLS),
      tiling: 'regular',
    }
    detailSetups.set(setup, d)
  }
  return d
}

/** The coarse scrub setup: same job area, coarse pitch, widened kernel, one tile. */
export function coarseSetup(full: SimSetup): SimSetup {
  const grid = coarseGrid(full.grid)
  const kernel = coarseKernel(full.kernel, grid.pitchMm)
  const whole = { x: 0, y: 0, width: grid.width, height: grid.height }
  const marginCells = Math.ceil(kernelRadiusMm(kernel) / grid.pitchMm)
  return {
    ...full,
    kernel,
    separable: separableKernel(kernel, grid.pitchMm),
    grid,
    plan: { grid, marginCells, cols: 1, rows: 1, tiles: [{ col: 0, row: 0, core: whole, padded: whole }] },
    tiling: 'regular',
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

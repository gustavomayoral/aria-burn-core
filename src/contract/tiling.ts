// SPDX-License-Identifier: MIT
// Tiling (core-internal). The budget is GPU bytes, not millimetres or bed size.
//
// BURN-36: COD-252's 9000² cap only tested allocating one render target. A tile
// allocates a pool of TILE_CELL_BYTES per padded cell, and other textures stay
// resident beside it, so on an integrated GPU (Iris Xe) a 6711² tile already
// fails. The tile side is therefore derived from a byte budget for everything
// a run keeps on the GPU (GPU_BUDGET_BYTES), and TILE_MAX_CELLS stays only as a
// hard cap from the render-target limit.
//
// Rules (normative):
//   - The job grid covers JobModel.burnBounds expanded by kernelRadiusMm on every
//     side, snapped outward to whole cells at gridPitchMm.
//   - The tile side S = min(TILE_MAX_CELLS, tileSideForBytes(budget left for the
//     tile pool)), where the pool budget is defaultGpuBudgetBytes(renderer)
//     (or an override) minus what else is resident on the GPU, and
//     S ≥ TILE_MIN_CELLS. Planning without a GPU
//     (CPU reference, tests) may use any S ≤ TILE_MAX_CELLS.
//   - If the job grid fits in S × S it is one tile.
//   - Otherwise it is split into a regular array of tiles. Each tile's padded
//     size, core plus marginCells on each side, is at most S.
//     marginCells = ceil(kernelRadiusMm / pitch).
//   - If allocating a tile pool fails, the run retries with a smaller S; results
//     do not depend on S beyond the seam tolerance.
//   - Each tile deposits every sample inside its padded rect, blurs, and keeps
//     only its core. Cores partition the job grid exactly, so stitched results
//     match a single untiled run.

import { kernelRadiusMm, type GridSpec, type KernelSigma } from './deposit.ts'
import type { BoundsMm } from './common.ts'

/** Hard cap on a padded tile side: the largest render target both platforms allocate (COD-252). */
export const TILE_MAX_CELLS = 9000

/**
 * GPU bytes per padded tile cell: two R32F ping-pong targets, RGBA8 colour,
 * R32F depth and R8UI verdict.
 */
export const TILE_CELL_BYTES = 4 + 4 + 4 + 4 + 1

/**
 * Budget for everything a run keeps on the GPU (tile pool, overview, coarse
 * pool and checkpoints, thermal textures, sample buffers) on an integrated
 * Intel GPU. Provisional (BURN-36): Iris Xe ran a ~615 MB pool next to a
 * ~116 MB overview and failed a ~767 MB one, so it stays under that until the
 * tile-size step bench measures the real limit.
 */
export const GPU_BUDGET_BYTES = 768 * 1024 * 1024

/**
 * Budget on other GPUs (Apple silicon, discrete). Provisional: an M1 holds a
 * 9000² pool beside a 4096² overview (~1.7 GB). Allocation failures still fall
 * back to smaller tiles, so a guess that is too high costs one retry.
 */
export const GPU_BUDGET_LARGE_BYTES = 1536 * 1024 * 1024

/** Default budget for a GPU by its renderer string (WebGL has no memory query). */
export function defaultGpuBudgetBytes(renderer: string): number {
  return /intel|iris|uhd graphics|hd graphics/i.test(renderer) ? GPU_BUDGET_BYTES : GPU_BUDGET_LARGE_BYTES
}

/**
 * Smallest tile side worth running (~17 MB pool). Below it per-tile overhead
 * dominates and smaller tiles free almost nothing, so the budget is treated as
 * exhausted and tiles stay this size.
 */
export const TILE_MIN_CELLS = 1024

/** Largest square tile side whose pool fits in `bytes`, capped at TILE_MAX_CELLS. */
export function tileSideForBytes(bytes: number): number {
  return Math.min(TILE_MAX_CELLS, Math.floor(Math.sqrt(Math.max(0, bytes) / TILE_CELL_BYTES)))
}

/** GPU bytes of one tile pool of padded size w × h. */
export const tilePoolBytes = (w: number, h: number) => w * h * TILE_CELL_BYTES

export interface CellRect {
  /** Inclusive start cell in job-grid coordinates. */
  x: number
  y: number
  width: number
  height: number
}

export interface Tile {
  col: number
  row: number
  /** Cells this tile owns in the stitched output. */
  core: CellRect
  /** Core plus margin, clipped to the job grid; what the tile allocates. */
  padded: CellRect
}

export interface TilePlan {
  grid: GridSpec
  marginCells: number
  cols: number
  rows: number
  tiles: Tile[]
}

export function planJobGrid(burnBounds: BoundsMm, pitchMm: number, kernel: KernelSigma): GridSpec {
  const r = kernelRadiusMm(kernel)
  const originXMm = Math.floor((burnBounds.minXMm - r) / pitchMm) * pitchMm
  const originYMm = Math.floor((burnBounds.minYMm - r) / pitchMm) * pitchMm
  const width = Math.max(1, Math.ceil((burnBounds.maxXMm + r - originXMm) / pitchMm))
  const height = Math.max(1, Math.ceil((burnBounds.maxYMm + r - originYMm) / pitchMm))
  return { originXMm, originYMm, pitchMm, width, height }
}

export function planTiles(grid: GridSpec, kernel: KernelSigma, maxCells = TILE_MAX_CELLS): TilePlan {
  const marginCells = Math.ceil(kernelRadiusMm(kernel) / grid.pitchMm)
  if (grid.width <= maxCells && grid.height <= maxCells) {
    const whole = { x: 0, y: 0, width: grid.width, height: grid.height }
    return { grid, marginCells, cols: 1, rows: 1, tiles: [{ col: 0, row: 0, core: whole, padded: whole }] }
  }
  const coreMax = maxCells - 2 * marginCells
  if (coreMax < 1) throw new Error(`tiling: kernel margin ${marginCells} cells leaves no core in ${maxCells}`)
  const cols = Math.ceil(grid.width / coreMax)
  const rows = Math.ceil(grid.height / coreMax)
  const coreW = Math.ceil(grid.width / cols)
  const coreH = Math.ceil(grid.height / rows)
  const tiles: Tile[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * coreW
      const y = row * coreH
      const core = { x, y, width: Math.min(coreW, grid.width - x), height: Math.min(coreH, grid.height - y) }
      const px = Math.max(0, x - marginCells)
      const py = Math.max(0, y - marginCells)
      const padded = {
        x: px,
        y: py,
        width: Math.min(grid.width, x + core.width + marginCells) - px,
        height: Math.min(grid.height, y + core.height + marginCells) - py,
      }
      tiles.push({ col, row, core, padded })
    }
  }
  return { grid, marginCells, cols, rows, tiles }
}

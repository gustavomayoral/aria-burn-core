// Tiling (core-internal). Budget is cells, not millimetres or bed size
// (COD-252: 9000² is the largest render target both platforms allocate).
//
// Rules (normative):
//   - The job grid covers JobModel.burnBounds expanded by kernelRadiusMm on every
//     side, snapped outward to whole cells at gridPitchMm.
//   - If the job grid fits in TILE_MAX_CELLS × TILE_MAX_CELLS it is one tile.
//   - Otherwise it is split into a regular array of tiles. Each tile's padded
//     size, core plus marginCells on each side, is at most TILE_MAX_CELLS.
//     marginCells = ceil(kernelRadiusMm / pitch).
//   - Each tile deposits every sample inside its padded rect, blurs, and keeps
//     only its core. Cores partition the job grid exactly, so stitched results
//     match a single untiled run.

import { kernelRadiusMm, type GridSpec, type KernelSigma } from './deposit.ts'
import type { BoundsMm } from './common.ts'

export const TILE_MAX_CELLS = 9000

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

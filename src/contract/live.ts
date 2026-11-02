// SPDX-License-Identifier: MIT
// Live (network) jobs (core-internal, COD-264). Samples arrive while the
// stream runs; job.loaded (bounds) and plan.done (durationS) only arrive at
// the end. The messages are job.streaming and job.progress (messages.ts).
//
// Rules (normative):
//   - Live grid. The job grid is planJobGrid over the burn bounds of the
//     samples received so far. Its origin is snapped to whole cells of the
//     absolute lattice (cell k spans [k·pitch, (k+1)·pitch)), so as the bounds
//     grow the grid only gains cells; existing cells never move.
//   - Live tiling. Tiles sit on a fixed absolute lattice instead of splitting
//     the current grid evenly: tile (col, row) owns lattice cells
//     [col·C, (col+1)·C) × [row·C, (row+1)·C), C = TILE_MAX_CELLS − 2·marginCells,
//     clipped to the job grid, padded by marginCells like planTiles. A tile
//     exists once the grid reaches it (lazy allocation) and never moves, so a
//     refresh only re-runs tiles whose padded rect received new samples. Every
//     padded rect stays within TILE_MAX_CELLS². When job.loaded arrives the job
//     switches to planTiles; both match untiled within the seam tolerance.
//   - Live head. headS = max(job.progress plannedS, end of the last sample
//     received). Before plan.done the timeline is [0, headS] and grows; after
//     it, [0, durationS].
//   - Live scrub. progress ∈ [0, 1] maps to cutoffS = progress × headS, so
//     scrubbing only reaches what has arrived. Follow live pins the cutoff to
//     headS and tracks it as data arrives; dragging the scrubber leaves Follow,
//     and moving it back to the end (progress = 1) re-enters it.
//   - Running stats (job panel) update on every batch: bounds, grid size, tile
//     count and the totals below. Missing batch sequence numbers are reported,
//     never papered over.

import type { BoundsMm } from './common.ts'
import { kernelRadiusMm, type GridSpec, type KernelSigma } from './deposit.ts'
import { TILE_MAX_CELLS, type Tile, type TilePlan } from './tiling.ts'

/** Lattice index of a grid's first cell (grids from planJobGrid are lattice-aligned). */
export function latticeCell(originMm: number, pitchMm: number): number {
  return Math.round(originMm / pitchMm)
}

export function planLiveTiles(grid: GridSpec, kernel: KernelSigma, maxCells = TILE_MAX_CELLS): TilePlan {
  const marginCells = Math.ceil(kernelRadiusMm(kernel) / grid.pitchMm)
  const coreCells = maxCells - 2 * marginCells
  if (coreCells < 1) throw new Error(`live tiling: kernel margin ${marginCells} cells leaves no core in ${maxCells}`)
  const gx = latticeCell(grid.originXMm, grid.pitchMm)
  const gy = latticeCell(grid.originYMm, grid.pitchMm)
  const col0 = Math.floor(gx / coreCells)
  const col1 = Math.floor((gx + grid.width - 1) / coreCells)
  const row0 = Math.floor(gy / coreCells)
  const row1 = Math.floor((gy + grid.height - 1) / coreCells)
  const tiles: Tile[] = []
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const x = Math.max(col * coreCells, gx) - gx
      const y = Math.max(row * coreCells, gy) - gy
      const core = {
        x,
        y,
        width: Math.min((col + 1) * coreCells - gx, grid.width) - x,
        height: Math.min((row + 1) * coreCells - gy, grid.height) - y,
      }
      const px = Math.max(0, core.x - marginCells)
      const py = Math.max(0, core.y - marginCells)
      const padded = {
        x: px,
        y: py,
        width: Math.min(grid.width, core.x + core.width + marginCells) - px,
        height: Math.min(grid.height, core.y + core.height + marginCells) - py,
      }
      tiles.push({ col, row, core, padded })
    }
  }
  return { grid, marginCells, cols: col1 - col0 + 1, rows: row1 - row0 + 1, tiles }
}

export function liveHeadS(plannedS: number, sampledUntilS: number): number {
  return Math.max(plannedS, sampledUntilS)
}

/** Live scrub cutoff: Follow live tracks the head; otherwise progress × head. */
export function liveScrubCutoffS(progress: number, headS: number, follow: boolean): number {
  if (follow) return headS
  return Math.min(1, Math.max(0, progress)) * headS
}

/** Job-panel stats, updated as samples arrive. */
export interface LiveJobStats {
  jobId: number
  name: string
  /** True from job.streaming until plan.done. */
  streaming: boolean
  /** Timeline length so far: headS while streaming, durationS after plan.done (s). */
  headS: number
  lineCount: number
  batchCount: number
  sampleCount: number
  /** Σ powerW × dtS of the samples received (J, optical). */
  energyJ: number
  /** Batch sequence numbers skipped so far (a dropped Channel message). */
  missingBatches: number[]
  burnBounds: BoundsMm | null
  /** Job grid from the burn bounds so far; null before the first sample. */
  grid: Pick<GridSpec, 'width' | 'height' | 'pitchMm'> | null
  tileCols: number
  tileRows: number
  tileCount: number
}

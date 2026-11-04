// SPDX-License-Identifier: MIT
// Tile side from the GPU byte budget, and the smaller-tile retry (BURN-36).
// Pure: the WebGL path (gl/gl-sim.ts) supplies what is resident and the
// attempt; tests drive it with a fake allocator.

import {
  TILE_MAX_CELLS,
  TILE_MIN_CELLS,
  planLiveTiles,
  planTiles,
  tileSideForBytes,
  type TilePlan,
} from '../contract/index.ts'
import type { SimSetup } from './job.ts'

export interface TileBudget {
  /** Everything a run may keep on the GPU (bytes). */
  budgetBytes: number
  /** Resident on the GPU besides the tile pool (bytes). */
  otherBytes: number
  /** Device caps and learned limits that also bound the side. */
  maxSide?: number
}

/**
 * Tile side for a budget: what's left after other residents, at least
 * TILE_MIN_CELLS, then capped by `maxSide` (hard limits win over the floor).
 */
export function tileSide(b: TileBudget): number {
  const fromBudget = Math.max(TILE_MIN_CELLS, tileSideForBytes(b.budgetBytes - b.otherBytes))
  return Math.min(fromBudget, b.maxSide ?? TILE_MAX_CELLS)
}

/** Largest padded side in a plan. */
export const planSide = (plan: TilePlan) => Math.max(...plan.tiles.map((t) => Math.max(t.padded.width, t.padded.height)))

/** The setup's plan rebuilt with padded tiles of at most `side`, keeping its tiling (regular or live lattice). */
export function replan(setup: SimSetup, side: number): TilePlan {
  return setup.tiling === 'live' ? planLiveTiles(setup.grid, setup.kernel, side) : planTiles(setup.grid, setup.kernel, side)
}

/** Next side to try after an allocation failed at `side`: about half the pool bytes. */
export const shrinkSide = (side: number) => Math.floor(side * Math.SQRT1_2)

export interface FallbackResult<T> {
  result: T
  /** Side the attempt finally succeeded at. */
  side: number
  /** Sides that failed, largest first. */
  failed: number[]
}

/**
 * Run `attempt(side)`; when it throws an error `isAllocationFailure` accepts,
 * retry with a smaller side down to `minSide`, then rethrow. Other errors
 * propagate at once.
 */
export function withTileFallback<T>(
  side: number,
  attempt: (side: number) => T,
  isAllocationFailure: (e: unknown) => boolean,
  minSide = TILE_MIN_CELLS,
): FallbackResult<T> {
  const failed: number[] = []
  for (;;) {
    try {
      return { result: attempt(side), side, failed }
    } catch (e) {
      if (!isAllocationFailure(e)) throw e
      failed.push(side)
      const next = shrinkSide(side)
      if (next < minSide) throw e
      side = next
    }
  }
}

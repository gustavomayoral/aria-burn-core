// SPDX-License-Identifier: MIT
// Hover readout (contract CellReadout): everything about one cell, computed
// on demand from the samples instead of read back from GPU tiles. A cell's
// fluence is Σ_samples E·abs/pitch² · bilinear · kernel, so only samples
// within the kernel reach of the cell matter; a bucket index finds them.
// It matches the grid pipeline exactly (same deposit and kernel weights) and
// works at any zoom, for any tile, while live samples keep arriving.

import { classifyFluence, type CellReadout } from '../contract/index.ts'
import type { SimSetup } from './job.ts'
import { cellDepthMm, cellLab, responseParams } from './response.ts'
import type { SampleStore } from './sample-store.ts'

/** Most-contributing source lines reported per cell. */
export const READOUT_MAX_LINES = 5

/** Samples bucketed on a coarse square grid (CSR), rebuilt when the store grows. */
class BucketIndex {
  readonly version: number
  readonly count: number
  readonly start: Uint32Array
  readonly items: Uint32Array
  readonly cols: number
  readonly rows: number

  constructor(
    store: SampleStore,
    readonly originXMm: number,
    readonly originYMm: number,
    readonly bucketMm: number,
    cols: number,
    rows: number,
  ) {
    this.version = store.version
    this.count = store.count
    this.cols = cols
    this.rows = rows
    const n = store.count
    const bucketOf = new Uint32Array(n)
    const counts = new Uint32Array(cols * rows + 1)
    for (let s = 0; s < n; s++) {
      const bx = Math.min(cols - 1, Math.max(0, Math.floor((store.xye[s * 3]! - originXMm) / bucketMm)))
      const by = Math.min(rows - 1, Math.max(0, Math.floor((store.xye[s * 3 + 1]! - originYMm) / bucketMm)))
      const b = by * cols + bx
      bucketOf[s] = b
      counts[b + 1]!++
    }
    for (let b = 0; b < cols * rows; b++) counts[b + 1]! += counts[b]!
    this.start = counts.slice()
    const fill = counts
    this.items = new Uint32Array(n)
    // Samples stay in time order within a bucket, so a cutoff is a prefix per bucket.
    for (let s = 0; s < n; s++) this.items[fill[bucketOf[s]!]!++] = s
  }

  /** Call fn(sampleIndex) for every sample in buckets overlapping [x0,x1]×[y0,y1]. */
  forEach(x0: number, y0: number, x1: number, y1: number, limit: number, fn: (s: number) => void): void {
    const bx0 = Math.max(0, Math.floor((x0 - this.originXMm) / this.bucketMm))
    const bx1 = Math.min(this.cols - 1, Math.floor((x1 - this.originXMm) / this.bucketMm))
    const by0 = Math.max(0, Math.floor((y0 - this.originYMm) / this.bucketMm))
    const by1 = Math.min(this.rows - 1, Math.floor((y1 - this.originYMm) / this.bucketMm))
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = by * this.cols + bx
        for (let k = this.start[b]!; k < this.start[b + 1]!; k++) {
          const s = this.items[k]!
          if (s >= limit) break
          fn(s)
        }
      }
  }
}

export class CellReader {
  private index: BucketIndex | null = null

  constructor(
    private readonly store: SampleStore,
    private setup: SimSetup,
  ) {}

  /** Swap in a new setup (live jobs grow their grid; material changes). */
  setSetup(setup: SimSetup): void {
    this.setup = setup
    this.index = null
  }

  private bucketIndex(): BucketIndex {
    const { store } = this
    if (this.index && this.index.version === store.version) return this.index
    const b = store.burnBounds ?? { minXMm: 0, minYMm: 0, maxXMm: 0, maxYMm: 0 }
    const bucketMm = Math.max(0.5, (b.maxXMm - b.minXMm + b.maxYMm - b.minYMm) / 2048)
    const cols = Math.max(1, Math.ceil((b.maxXMm - b.minXMm) / bucketMm) + 1)
    const rows = Math.max(1, Math.ceil((b.maxYMm - b.minYMm) / bucketMm) + 1)
    this.index = new BucketIndex(store, b.minXMm, b.minYMm, bucketMm, cols, rows)
    return this.index
  }

  /** Fluence (J/mm²) of job-grid cell (cx, cy) and per-line contributions. */
  private evaluate(cx: number, cy: number, limit: number, lines: Map<number, number> | null): number {
    const { grid, separable, material } = this.setup
    const { pitchMm } = grid
    const kx = separable.x
    const ky = separable.y
    const scale = material.absorption / (pitchMm * pitchMm)
    // Cells that can blur into (cx, cy), widened by one cell for the bilinear footprint.
    const reachX = (kx.radius + 1) * pitchMm
    const reachY = (ky.radius + 1) * pitchMm
    const centreX = grid.originXMm + (cx + 0.5) * pitchMm
    const centreY = grid.originYMm + (cy + 0.5) * pitchMm
    const xye = this.store.xye
    let total = 0
    this.bucketIndex().forEach(centreX - reachX, centreY - reachY, centreX + reachX, centreY + reachY, limit, (s) => {
      const fx = (xye[s * 3]! - grid.originXMm) / pitchMm - 0.5
      const fy = (xye[s * 3 + 1]! - grid.originYMm) / pitchMm - 0.5
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      const ax = fx - ix
      const ay = fy - iy
      let w = 0
      for (let dy = 0; dy < 2; dy++) {
        const oy = cy - (iy + dy)
        if (oy < -ky.radius || oy > ky.radius) continue
        if (iy + dy < 0 || iy + dy >= grid.height) continue
        const wy = (dy ? ay : 1 - ay) * ky.weights[oy + ky.radius]!
        for (let dx = 0; dx < 2; dx++) {
          const ox = cx - (ix + dx)
          if (ox < -kx.radius || ox > kx.radius) continue
          if (ix + dx < 0 || ix + dx >= grid.width) continue
          w += (dx ? ax : 1 - ax) * kx.weights[ox + kx.radius]! * wy
        }
      }
      if (w === 0) return
      const f = w * xye[s * 3 + 2]! * scale
      total += f
      if (lines) {
        const line = this.store.line[s]!
        lines.set(line, (lines.get(line) ?? 0) + f)
      }
    })
    return total
  }

  /** Readout at an absolute machine position, for samples up to the time cutoff. */
  readAt(xMm: number, yMm: number, timeCutoffS = Infinity): CellReadout | null {
    const { grid, material } = this.setup
    const cx = Math.floor((xMm - grid.originXMm) / grid.pitchMm)
    const cy = Math.floor((yMm - grid.originYMm) / grid.pitchMm)
    if (cx < 0 || cy < 0 || cx >= grid.width || cy >= grid.height) return null
    return this.readCell(cx, cy, timeCutoffS, material)
  }

  readCell(cx: number, cy: number, timeCutoffS = Infinity, material = this.setup.material): CellReadout {
    const { grid } = this.setup
    const limit = this.store.countUntil(timeCutoffS)
    const lines = new Map<number, number>()
    const f = this.evaluate(cx, cy, limit, lines)
    const p = responseParams(material)
    let polished = false
    if (p.polishedEdge && f < p.depthThreshold && f >= p.edgeMinFluence) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
        if (this.evaluate(cx + dx, cy + dy, limit, null) >= p.depthThreshold) polished = true
    }
    return {
      cellX: cx,
      cellY: cy,
      xMm: grid.originXMm + (cx + 0.5) * grid.pitchMm,
      yMm: grid.originYMm + (cy + 0.5) * grid.pitchMm,
      fluenceJPerMm2: f,
      depthMm: cellDepthMm(p, f),
      color: cellLab(p, f, polished),
      verdict: classifyFluence(material, f),
      peakTemperatureK: null,
      lines: [...lines.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, READOUT_MAX_LINES)
        .map(([line]) => line),
    }
  }
}

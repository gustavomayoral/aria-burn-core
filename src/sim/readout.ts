// SPDX-License-Identifier: MIT
// Hover readout (contract CellReadout): everything about one cell, computed
// on demand from the samples instead of read back from GPU tiles. A cell's
// fluence is Σ_samples E·abs/pitch² · bilinear · kernel, so only samples
// within the kernel reach of the cell matter; a bucket index finds them.
// It matches the grid pipeline exactly (same deposit and kernel weights) and
// works at any zoom, for any tile, while live samples keep arriving.

import { classifyFluence, classifyThermal, type CellReadout } from '../contract/index.ts'
import type { SimSetup } from './job.ts'
import { cellDepthMm, cellLab, responseParams } from './response.ts'
import type { SampleStore } from './sample-store.ts'
import { bulkAt, thermalFor, type ThermalResult } from './thermal.ts'

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

  /** The setup the reader evaluates on (the detail setup in the app). */
  get simSetup(): SimSetup {
    return this.setup
  }

  /** The thermal step's result for the store as it is now (cached), or null without a thermal model. */
  thermal(): ThermalResult | null {
    const { machine, material, thermalKernel, thermalStep, thermalPlanning } = this.setup
    return thermalFor(this.store, machine, material, thermalKernel, thermalStep, thermalPlanning)
  }

  /**
   * Fluence (J/mm²) of job-grid cell (cx, cy) and per-line contributions. With
   * `energies` (a thermal step's per-sample eAbs or eDose) those replace E·absorption.
   */
  private evaluate(cx: number, cy: number, limit: number, lines: Map<number, number> | null, energies: Float32Array | null = null): number {
    const { pitchMm } = this.setup.grid
    const scale = this.setup.material.absorption / (pitchMm * pitchMm)
    const inv2 = 1 / (pitchMm * pitchMm)
    const xye = this.store.xye
    let total = 0
    this.visit(cx, cy, limit, (s, w) => {
      const f = energies ? w * energies[s]! * inv2 : w * xye[s * 3 + 2]! * scale
      total += f
      if (lines) {
        const line = this.store.line[s]!
        lines.set(line, (lines.get(line) ?? 0) + f)
      }
    })
    return total
  }

  /**
   * Calls fn(sample, w) for every sample before `limit` that reaches job-grid
   * cell (cx, cy), with w its deposit weight there (bilinear × blur kernel,
   * dimensionless): the cell gets w · E / pitch² from it, exactly as the grid
   * pipeline deposits it. The outcome explanation (BURN-45) reads it.
   */
  visit(cx: number, cy: number, limit: number, fn: (sample: number, w: number) => void): void {
    const { grid, separable } = this.setup
    const { pitchMm } = grid
    const kx = separable.x
    const ky = separable.y
    const skew = separable.skew
    // Kernel weight from deposit cell (X, Y) to (cx, cy): the X pass, then the Y pass,
    // which for a rotated spot reads the X pass at cx + offset and the cell after it.
    const xWeight = (from: number, at: number): number => {
      const o = at - from
      return o < -kx.radius || o > kx.radius || at < 0 || at >= grid.width ? 0 : kx.weights[o + kx.radius]!
    }
    const kernelAt = (X: number, Y: number): number => {
      const t = Y - cy
      if (t < -ky.radius || t > ky.radius) return 0
      const tap = t + ky.radius
      if (!skew) return ky.weights[tap]! * xWeight(X, cx)
      const at = cx + skew.offset[tap]!
      return skew.w0[tap]! * xWeight(X, at) + skew.w1[tap]! * xWeight(X, at + 1)
    }
    const maxShift = skew ? Math.ceil(Math.abs(skew.shear) * ky.radius) : 0
    // Cells that can blur into (cx, cy), widened by one cell for the bilinear footprint.
    const reachX = (kx.radius + maxShift + 1) * pitchMm
    const reachY = (ky.radius + 1) * pitchMm
    const centreX = grid.originXMm + (cx + 0.5) * pitchMm
    const centreY = grid.originYMm + (cy + 0.5) * pitchMm
    const xye = this.store.xye
    this.bucketIndex().forEach(centreX - reachX, centreY - reachY, centreX + reachX, centreY + reachY, limit, (s) => {
      const fx = (xye[s * 3]! - grid.originXMm) / pitchMm - 0.5
      const fy = (xye[s * 3 + 1]! - grid.originYMm) / pitchMm - 0.5
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      const ax = fx - ix
      const ay = fy - iy
      let w = 0
      for (let dy = 0; dy < 2; dy++) {
        if (iy + dy < 0 || iy + dy >= grid.height) continue
        const wy = dy ? ay : 1 - ay
        for (let dx = 0; dx < 2; dx++) {
          if (ix + dx < 0 || ix + dx >= grid.width) continue
          w += (dx ? ax : 1 - ax) * wy * kernelAt(ix + dx, iy + dy)
        }
      }
      if (w !== 0) fn(s, w)
    })
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
    const thermal = this.thermal()
    const fluence = this.evaluate(cx, cy, limit, thermal ? null : lines, thermal?.eAbs ?? null)
    // The response reads dose with a thermal model; lines rank by dose then.
    const f = thermal ? this.evaluate(cx, cy, limit, lines, thermal.eDose) : fluence
    const p = responseParams(material)
    let polished = false
    if (p.polishedEdge && f < p.depthThreshold && f >= p.edgeMinFluence) {
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
        if (this.evaluate(cx + dx, cy + dy, limit, null, thermal?.eDose ?? null) >= p.depthThreshold) polished = true
    }
    const xMm = grid.originXMm + (cx + 0.5) * grid.pitchMm
    const yMm = grid.originYMm + (cy + 0.5) * grid.pitchMm
    const bulk = thermal ? bulkAt(thermal, xMm, yMm) : null
    return {
      cellX: cx,
      cellY: cy,
      xMm,
      yMm,
      fluenceJPerMm2: fluence,
      depthMm: cellDepthMm(p, f),
      color: cellLab(p, f, polished),
      verdict: thermal ? classifyThermal(material, f, bulk!) : classifyFluence(material, f),
      doseJPerMm2: thermal ? f : null,
      peakTemperatureK: thermal ? thermal.ambientK + thermal.flashK * f : null,
      bulkTemperatureK: bulk,
      lines: [...lines.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, READOUT_MAX_LINES)
        .map(([line]) => line),
    }
  }
}

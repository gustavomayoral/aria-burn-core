// SPDX-License-Identifier: MIT
// Spatial bins for tiled deposit: samples reordered into square buckets on an
// absolute mm lattice (stable, so each bucket stays in time order), so a tile
// only draws the samples that can reach it instead of the whole job. A time
// cutoff is a prefix of every bucket. Rebuilt by counting sort, O(n).
//
// Window bins (BURN-41) hold only the buckets of a window of that lattice: a
// detail run bins what its view needs instead of the whole job. A bucket holds
// the same samples in the same order either way, so a rect inside the window
// draws the same samples in the same order, and the deposit is bit-identical.

import type { SampleStore } from './sample-store.ts'

/** A contiguous run of binned samples: [first, first + count). */
export type SampleRange = [first: number, count: number]

/** Buckets [bx0, bx1] × [by0, by1] of the bin lattice (inclusive, lattice-relative: 0 … cols − 1). */
export interface BucketWindow {
  bx0: number
  by0: number
  bx1: number
  by1: number
}

/** The bin lattice over a store's burn bounds: absolute bucket index of its first column and row, and its size. */
export interface BinLattice {
  bucketMm: number
  bx0: number
  by0: number
  cols: number
  rows: number
}

export function binLattice(store: SampleStore, bucketMm: number): BinLattice {
  const b = store.burnBounds ?? { minXMm: 0, minYMm: 0, maxXMm: 0, maxYMm: 0 }
  const bx0 = Math.floor(b.minXMm / bucketMm)
  const by0 = Math.floor(b.minYMm / bucketMm)
  return { bucketMm, bx0, by0, cols: Math.floor(b.maxXMm / bucketMm) - bx0 + 1, rows: Math.floor(b.maxYMm / bucketMm) - by0 + 1 }
}

/** Lattice buckets overlapping the mm rect (clamped to the lattice; empty when bx0 > bx1 or by0 > by1). */
export function bucketsOf(l: BinLattice, x0Mm: number, y0Mm: number, x1Mm: number, y1Mm: number): BucketWindow {
  return {
    bx0: Math.max(0, Math.floor(x0Mm / l.bucketMm) - l.bx0),
    bx1: Math.min(l.cols - 1, Math.floor(x1Mm / l.bucketMm) - l.bx0),
    by0: Math.max(0, Math.floor(y0Mm / l.bucketMm) - l.by0),
    by1: Math.min(l.rows - 1, Math.floor(y1Mm / l.bucketMm) - l.by0),
  }
}

export class SampleBins {
  readonly version: number
  readonly count: number
  /** Samples in bucket order: interleaved [x, y, energyJ], as in SampleStore.xye. */
  readonly xye: Float32Array
  readonly tS: Float64Array
  /** Store index of each binned sample (per-sample thermal energies are looked up by it, COD-258). */
  readonly index: Uint32Array
  /** Bucket b of the window (row-major over the window) holds [start[b], start[b + 1]). */
  readonly start: Uint32Array
  /** The lattice: absolute bucket index of its first column and row, and its size (the job's burn bounds). */
  readonly bx0: number
  readonly by0: number
  readonly cols: number
  readonly rows: number
  /** The buckets these bins hold: the whole lattice, or the window asked for (clamped to it). */
  readonly window: BucketWindow

  constructor(
    store: SampleStore,
    readonly bucketMm: number,
    window?: BucketWindow,
  ) {
    this.version = store.version
    const l = binLattice(store, bucketMm)
    this.bx0 = l.bx0
    this.by0 = l.by0
    this.cols = l.cols
    this.rows = l.rows
    const whole = { bx0: 0, by0: 0, bx1: this.cols - 1, by1: this.rows - 1 }
    this.window = window
      ? {
          bx0: Math.max(0, Math.min(this.cols - 1, window.bx0)),
          by0: Math.max(0, Math.min(this.rows - 1, window.by0)),
          bx1: Math.max(0, Math.min(this.cols - 1, window.bx1)),
          by1: Math.max(0, Math.min(this.rows - 1, window.by1)),
        }
      : whole
    const w = this.window
    if (w.bx0 === 0 && w.by0 === 0 && w.bx1 === whole.bx1 && w.by1 === whole.by1) {
      const all = this.binAll(store)
      this.count = all.count
      this.start = all.start
      this.xye = all.xye
      this.tS = all.tS
      this.index = all.index
    } else {
      const part = this.binWindow(store, w)
      this.count = part.count
      this.start = part.start
      this.xye = part.xye
      this.tS = part.tS
      this.index = part.index
    }
  }

  /** True when these bins hold the whole lattice. */
  get isWhole(): boolean {
    const w = this.window
    return w.bx0 === 0 && w.by0 === 0 && w.bx1 === this.cols - 1 && w.by1 === this.rows - 1
  }

  /** Every sample, by counting sort. */
  private binAll(store: SampleStore) {
    const bucketMm = this.bucketMm
    const n = store.count
    const src = store.xye
    const bucketOf = new Uint32Array(n)
    const start = new Uint32Array(this.cols * this.rows + 1)
    for (let s = 0; s < n; s++) {
      const bx = Math.min(this.cols - 1, Math.max(0, Math.floor(src[s * 3]! / bucketMm) - this.bx0))
      const by = Math.min(this.rows - 1, Math.max(0, Math.floor(src[s * 3 + 1]! / bucketMm) - this.by0))
      const k = by * this.cols + bx
      bucketOf[s] = k
      start[k + 1]!++
    }
    for (let k = 0; k < this.cols * this.rows; k++) start[k + 1]! += start[k]!
    const fill = start.slice()
    const xye = new Float32Array(n * 3)
    const tS = new Float64Array(n)
    const index = new Uint32Array(n)
    for (let s = 0; s < n; s++) {
      const d = fill[bucketOf[s]!]!++
      index[d] = s
      xye[d * 3] = src[s * 3]!
      xye[d * 3 + 1] = src[s * 3 + 1]!
      xye[d * 3 + 2] = src[s * 3 + 2]!
      tS[d] = store.tS[s]!
    }
    return { count: n, start, xye, tS, index }
  }

  /**
   * Only the samples whose bucket is in `w`: one pass over the store that
   * keeps their indices, then a counting sort of those. Buckets are assigned
   * exactly as in binAll (same clamp), so each holds the same samples in the
   * same (store) order.
   */
  private binWindow(store: SampleStore, w: BucketWindow) {
    const bucketMm = this.bucketMm
    const n = store.count
    const src = store.xye
    const wcols = w.bx1 - w.bx0 + 1
    const wrows = w.by1 - w.by0 + 1
    const start = new Uint32Array(wcols * wrows + 1)
    let picked = new Uint32Array(1 << 16)
    let m = 0
    for (let s = 0; s < n; s++) {
      const bx = Math.min(this.cols - 1, Math.max(0, Math.floor(src[s * 3]! / bucketMm) - this.bx0))
      if (bx < w.bx0 || bx > w.bx1) continue
      const by = Math.min(this.rows - 1, Math.max(0, Math.floor(src[s * 3 + 1]! / bucketMm) - this.by0))
      if (by < w.by0 || by > w.by1) continue
      if (m === picked.length) {
        const grown = new Uint32Array(picked.length * 2)
        grown.set(picked)
        picked = grown
      }
      picked[m++] = s
      start[(by - w.by0) * wcols + (bx - w.bx0) + 1]!++
    }
    for (let k = 0; k < wcols * wrows; k++) start[k + 1]! += start[k]!
    const fill = start.slice()
    const xye = new Float32Array(m * 3)
    const tS = new Float64Array(m)
    const index = new Uint32Array(m)
    for (let j = 0; j < m; j++) {
      const s = picked[j]!
      const bx = Math.min(this.cols - 1, Math.max(0, Math.floor(src[s * 3]! / bucketMm) - this.bx0))
      const by = Math.min(this.rows - 1, Math.max(0, Math.floor(src[s * 3 + 1]! / bucketMm) - this.by0))
      const d = fill[(by - w.by0) * wcols + (bx - w.bx0)]!++
      index[d] = s
      xye[d * 3] = src[s * 3]!
      xye[d * 3 + 1] = src[s * 3 + 1]!
      xye[d * 3 + 2] = src[s * 3 + 2]!
      tS[d] = store.tS[s]!
    }
    return { count: m, start, xye, tS, index }
  }

  /** Lattice buckets overlapping the mm rect (clamped to the lattice). */
  bucketsOf(x0Mm: number, y0Mm: number, x1Mm: number, y1Mm: number): BucketWindow {
    return bucketsOf(this, x0Mm, y0Mm, x1Mm, y1Mm)
  }

  /** True when every bucket overlapping the mm rect is in these bins. */
  covers(x0Mm: number, y0Mm: number, x1Mm: number, y1Mm: number): boolean {
    const q = this.bucketsOf(x0Mm, y0Mm, x1Mm, y1Mm)
    const w = this.window
    // An empty query (rect off the lattice) needs nothing.
    if (q.bx0 > q.bx1 || q.by0 > q.by1) return true
    return q.bx0 >= w.bx0 && q.bx1 <= w.bx1 && q.by0 >= w.by0 && q.by1 <= w.by1
  }

  /** Samples with t <= cutoffS in bucket k, as a count from the bucket start. */
  private countUntil(k: number, cutoffS: number): number {
    let lo = this.start[k]!
    let hi = this.start[k + 1]!
    const first = lo
    if (cutoffS === Infinity) return hi - first
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.tS[mid]! <= cutoffS) lo = mid + 1
      else hi = mid
    }
    return lo - first
  }

  /**
   * Ranges covering every sample at or before the cutoff in buckets overlapping
   * the mm rect, bucket rows then columns, each bucket in time order. Adjacent
   * buckets merge. Window bins throw for a rect they don't cover.
   */
  ranges(x0Mm: number, y0Mm: number, x1Mm: number, y1Mm: number, cutoffS = Infinity): SampleRange[] {
    if (!this.covers(x0Mm, y0Mm, x1Mm, y1Mm)) throw new Error('SampleBins.ranges: rect outside the binned window')
    const out: SampleRange[] = []
    const { bx0, bx1, by0, by1 } = this.bucketsOf(x0Mm, y0Mm, x1Mm, y1Mm)
    const w = this.window
    const wcols = w.bx1 - w.bx0 + 1
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const k = (by - w.by0) * wcols + (bx - w.bx0)
        const n = this.countUntil(k, cutoffS)
        if (n === 0) continue
        const first = this.start[k]!
        const last = out[out.length - 1]
        if (last && last[0] + last[1] === first) last[1] += n
        else out.push([first, n])
      }
    }
    return out
  }
}

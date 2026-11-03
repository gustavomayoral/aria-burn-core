// SPDX-License-Identifier: MIT
// Spatial bins for tiled deposit: samples reordered into square buckets on an
// absolute mm lattice (stable, so each bucket stays in time order), so a tile
// only draws the samples that can reach it instead of the whole job. A time
// cutoff is a prefix of every bucket. Rebuilt by counting sort, O(n).

import type { SampleStore } from './sample-store.ts'

/** A contiguous run of binned samples: [first, first + count). */
export type SampleRange = [first: number, count: number]

export class SampleBins {
  readonly version: number
  readonly count: number
  /** Samples in bucket order: interleaved [x, y, energyJ], as in SampleStore.xye. */
  readonly xye: Float32Array
  readonly tS: Float64Array
  /** Store index of each binned sample (per-sample thermal energies are looked up by it, COD-258). */
  readonly index: Uint32Array
  /** Bucket b holds [start[b], start[b + 1]). */
  readonly start: Uint32Array
  readonly bx0: number
  readonly by0: number
  readonly cols: number
  readonly rows: number

  constructor(
    store: SampleStore,
    readonly bucketMm: number,
  ) {
    this.version = store.version
    const n = store.count
    this.count = n
    const b = store.burnBounds ?? { minXMm: 0, minYMm: 0, maxXMm: 0, maxYMm: 0 }
    this.bx0 = Math.floor(b.minXMm / bucketMm)
    this.by0 = Math.floor(b.minYMm / bucketMm)
    this.cols = Math.floor(b.maxXMm / bucketMm) - this.bx0 + 1
    this.rows = Math.floor(b.maxYMm / bucketMm) - this.by0 + 1
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
    this.start = start
    const fill = start.slice()
    this.xye = new Float32Array(n * 3)
    this.tS = new Float64Array(n)
    this.index = new Uint32Array(n)
    for (let s = 0; s < n; s++) {
      const d = fill[bucketOf[s]!]!++
      this.index[d] = s
      this.xye[d * 3] = src[s * 3]!
      this.xye[d * 3 + 1] = src[s * 3 + 1]!
      this.xye[d * 3 + 2] = src[s * 3 + 2]!
      this.tS[d] = store.tS[s]!
    }
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

  /** Ranges covering every sample at or before the cutoff in buckets overlapping the mm rect. Adjacent full buckets merge. */
  ranges(x0Mm: number, y0Mm: number, x1Mm: number, y1Mm: number, cutoffS = Infinity): SampleRange[] {
    const out: SampleRange[] = []
    const bx0 = Math.max(0, Math.floor(x0Mm / this.bucketMm) - this.bx0)
    const bx1 = Math.min(this.cols - 1, Math.floor(x1Mm / this.bucketMm) - this.bx0)
    const by0 = Math.max(0, Math.floor(y0Mm / this.bucketMm) - this.by0)
    const by1 = Math.min(this.rows - 1, Math.floor(y1Mm / this.bucketMm) - this.by0)
    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const k = by * this.cols + bx
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

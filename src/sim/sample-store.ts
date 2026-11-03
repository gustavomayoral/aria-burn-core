// SPDX-License-Identifier: MIT
// Sample store: the core's copy of a job's motion samples, appended batch by
// batch as they arrive (file jobs all at once, network jobs live).
//
// Layout is what deposit needs and nothing more:
//   xye   interleaved [xMm, yMm, energyJ] f32 per sample; energyJ = powerW · dtS
//         (optical, before absorption). Uploaded to the GPU as-is.
//   tS    absolute sample time (t0S + tRelS) in f64, non-decreasing, so a scrub
//         cutoff is a prefix: samples [0, countUntil(cutoff)).
//   line  1-based source line, for the hover readout.
//   dtS, speedMmPerS  per-sample interval and planner speed (f32), for the
//         thermal step's flash term (COD-258).

import { SAMPLE_FIELD_INDEX, SAMPLE_FIELD_COUNT, type BoundsMm, type SampleBatchView } from '../contract/index.ts'

const F = SAMPLE_FIELD_INDEX

export class SampleStore {
  count = 0
  xye = new Float32Array(0)
  tS = new Float64Array(0)
  line = new Uint32Array(0)
  dtS = new Float32Array(0)
  speedMmPerS = new Float32Array(0)
  /** Bounds of sample positions (beam-on only by the sampling rule); null until the first sample. */
  burnBounds: BoundsMm | null = null
  /** Σ powerW · dtS (J), f32 fields summed in f64 like the planner's plan.done energyJ. */
  energyJ = 0
  /** End of the last sample's interval (s): the time up to which deposit is complete. */
  sampledUntilS = 0
  batchCount = 0
  /** Next expected batch sequence; batches with other sequence numbers are recorded as gaps. */
  nextSequence = 0
  readonly missingSequences: number[] = []
  lastBatchSeen = false
  /** Bumped on every append, so caches (GPU buffers, spatial index) know when to refresh. */
  version = 0

  constructor(readonly jobId: number | null = null) {}

  private reserve(n: number): void {
    if (n <= this.tS.length) return
    const cap = Math.max(n, Math.ceil(this.tS.length * 1.5), 1024)
    const xye = new Float32Array(cap * 3)
    xye.set(this.xye.subarray(0, this.count * 3))
    const tS = new Float64Array(cap)
    tS.set(this.tS.subarray(0, this.count))
    const line = new Uint32Array(cap)
    line.set(this.line.subarray(0, this.count))
    const dtS = new Float32Array(cap)
    dtS.set(this.dtS.subarray(0, this.count))
    const speed = new Float32Array(cap)
    speed.set(this.speedMmPerS.subarray(0, this.count))
    this.xye = xye
    this.tS = tS
    this.line = line
    this.dtS = dtS
    this.speedMmPerS = speed
  }

  append(batch: SampleBatchView): void {
    if (this.jobId !== null && batch.jobId !== this.jobId)
      throw new Error(`sample store: batch for job ${batch.jobId}, expected ${this.jobId}`)
    for (let s = this.nextSequence; s < batch.sequence; s++) this.missingSequences.push(s)
    this.nextSequence = Math.max(this.nextSequence, batch.sequence + 1)
    this.batchCount++
    this.lastBatchSeen ||= batch.last
    const n = batch.sampleCount
    if (n === 0) return
    this.reserve(this.count + n)
    const { f32, u32 } = batch
    let b = this.burnBounds ?? { minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity }
    let { minXMm, minYMm, maxXMm, maxYMm } = b
    const lastT = this.count > 0 ? this.tS[this.count - 1]! : -Infinity
    for (let i = 0; i < n; i++) {
      const o = i * SAMPLE_FIELD_COUNT
      const j = this.count + i
      const x = f32[o + F.xMm]!
      const y = f32[o + F.yMm]!
      const dt = f32[o + F.dtS]!
      const p = f32[o + F.powerW]!
      const t = batch.t0S + f32[o + F.tRelS]!
      if (i === 0 && t < lastT) throw new Error(`sample store: batch ${batch.sequence} goes back in time`)
      this.xye[j * 3] = x
      this.xye[j * 3 + 1] = y
      this.xye[j * 3 + 2] = p * dt
      this.tS[j] = t
      this.line[j] = u32[o + F.line]!
      this.dtS[j] = dt
      this.speedMmPerS[j] = f32[o + F.speedMmPerS]!
      this.energyJ += p * dt
      if (x < minXMm) minXMm = x
      if (x > maxXMm) maxXMm = x
      if (y < minYMm) minYMm = y
      if (y > maxYMm) maxYMm = y
      const end = t + dt / 2
      if (end > this.sampledUntilS) this.sampledUntilS = end
    }
    b = { minXMm, minYMm, maxXMm, maxYMm }
    this.burnBounds = b
    this.count += n
    this.version++
  }

  /** Number of samples with t <= cutoffS (contract: a sample deposits iff t0S + tRelS <= cutoffS). */
  countUntil(cutoffS: number): number {
    if (cutoffS === Infinity) return this.count
    let lo = 0
    let hi = this.count
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.tS[mid]! <= cutoffS) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Σ energyJ over the first n samples (f64). */
  energyOf(n: number): number {
    let e = 0
    for (let i = 0; i < n; i++) e += this.xye[i * 3 + 2]!
    return e
  }
}

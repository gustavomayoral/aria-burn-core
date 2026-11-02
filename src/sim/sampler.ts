// SPDX-License-Identifier: MIT
// Interim motion sampler (COD-264): turns a JobModel into the same binary
// sample batches the Rust planner streams (samples.ts), so the pipeline runs
// before the planner port (COD-255) lands and can be swapped for it behind
// `MotionSampler`.
//
// Written from scratch from textbook kinematics; it is deliberately not GRBL's
// planner (that port is GPLv3 and lives in aria-burn). Model:
//   - Each move runs a trapezoid (accelerate, cruise, decelerate) at the
//     acceleration and max rate the axis limits allow along its direction.
//   - Junction speed between consecutive moves is min(v_a, v_b) · max(0, cos θ):
//     collinear segments keep speed, 90° and sharper corners stop. The job
//     starts and ends at rest. A backward then forward pass makes every entry
//     and exit speed reachable within the move's length.
//   - Blocks of constant acceleration are sampled per the contract's sampling
//     rule (interval midpoints, dt ≤ SAMPLE_DT_MAX_S, step ≤ gridPitchMm).
//   - Power uses the contract's opticalPowerW: M3 constant, M4 scaled by actual
//     over programmed speed. Only samples with power > 0 are emitted.

import {
  SAMPLE_BATCH_HEADER_BYTES,
  SAMPLE_BATCH_LAYOUT_VERSION,
  SAMPLE_BATCH_MAGIC,
  SAMPLE_BATCH_MAX_SAMPLES,
  SAMPLE_DT_MAX_S,
  SAMPLE_FIELD_COUNT,
  SAMPLE_FLAG_LAST,
  SAMPLE_STRIDE_BYTES,
  beamOn,
  gridPitchMm,
  opticalPowerW,
  type JobModel,
  type MachineProfile,
  type Move,
} from '../contract/index.ts'

/** What a planner hands the core: encoded batches plus the plan.done totals. */
export interface MotionPlan {
  /** Encoded sample batches, byte-identical to what the sample channel carries. */
  batches: ArrayBuffer[]
  /** Total job time including beam-off moves (s). */
  durationS: number
  sampleCount: number
  /** Σ powerW × dtS over all samples (J, optical, f32 fields summed in f64). */
  energyJ: number
}

/** Motion-sample source. The interim sampler now; the COD-255 planner (over the channel) later. */
export interface MotionSampler {
  readonly name: string
  plan(job: JobModel, machine: MachineProfile, jobId: number): MotionPlan
}

interface Segment {
  move: Move
  x0: number
  y0: number
  ux: number
  uy: number
  lengthMm: number
  /** Cruise target (mm/s). */
  vMax: number
  /** Acceleration along the move (mm/s²). */
  accel: number
  /** Programmed feed for M4 scaling (mm/min). */
  programmedMmPerMin: number
  vEntry: number
  vExit: number
}

/** Limit along a unit direction from per-axis limits: the tightest axis wins. */
function alongDirection(ux: number, uy: number, limitX: number, limitY: number): number {
  let v = Infinity
  if (Math.abs(ux) > 1e-12) v = Math.min(v, limitX / Math.abs(ux))
  if (Math.abs(uy) > 1e-12) v = Math.min(v, limitY / Math.abs(uy))
  return v
}

function segments(job: JobModel, machine: MachineProfile): Segment[] {
  const out: Segment[] = []
  let x = job.startMm.xMm
  let y = job.startMm.yMm
  for (const move of job.moves) {
    const dx = move.xMm - x
    const dy = move.yMm - y
    const lengthMm = Math.hypot(dx, dy)
    const x0 = x
    const y0 = y
    x = move.xMm
    y = move.yMm
    if (lengthMm < 1e-9) continue
    const ux = dx / lengthMm
    const uy = dy / lengthMm
    const rateMax = alongDirection(ux, uy, machine.maxRateMmPerMin.x, machine.maxRateMmPerMin.y)
    const accel = alongDirection(ux, uy, machine.accelMmPerS2.x, machine.accelMmPerS2.y)
    const programmed = move.kind === 'g0' ? rateMax : Math.min(move.feedMmPerMin, rateMax)
    // GRBL rejects G1 without a feed; the parser reports it. Skip it here rather than divide by zero.
    if (!(programmed > 0)) continue
    out.push({
      move,
      x0,
      y0,
      ux,
      uy,
      lengthMm,
      vMax: programmed / 60,
      accel,
      programmedMmPerMin: programmed,
      vEntry: 0,
      vExit: 0,
    })
  }
  return out
}

function planSpeeds(segs: Segment[]): void {
  const n = segs.length
  // Junction limits; job starts and ends at rest.
  const junction = new Float64Array(n + 1)
  for (let i = 1; i < n; i++) {
    const a = segs[i - 1]!
    const b = segs[i]!
    const cos = a.ux * b.ux + a.uy * b.uy
    junction[i] = Math.min(a.vMax, b.vMax) * Math.max(0, cos)
  }
  // Backward: every exit speed must be reachable by decelerating to the next limit.
  for (let i = n - 1; i >= 0; i--) {
    const s = segs[i]!
    s.vExit = Math.min(junction[i + 1]!, i + 1 < n ? segs[i + 1]!.vEntry : 0)
    s.vEntry = Math.min(junction[i]!, Math.sqrt(s.vExit ** 2 + 2 * s.accel * s.lengthMm))
  }
  // Forward: every exit speed must be reachable by accelerating from the entry.
  for (let i = 0; i < n; i++) {
    const s = segs[i]!
    if (i > 0) s.vEntry = Math.min(s.vEntry, segs[i - 1]!.vExit)
    s.vExit = Math.min(s.vExit, Math.sqrt(s.vEntry ** 2 + 2 * s.accel * s.lengthMm))
  }
}

/** Accumulates samples and cuts them into encoded batches. */
class BatchWriter {
  readonly batches: ArrayBuffer[] = []
  private buf = new ArrayBuffer(SAMPLE_BATCH_HEADER_BYTES + SAMPLE_BATCH_MAX_SAMPLES * SAMPLE_STRIDE_BYTES)
  private f32 = new Float32Array(this.buf, SAMPLE_BATCH_HEADER_BYTES)
  private u32 = new Uint32Array(this.buf, SAMPLE_BATCH_HEADER_BYTES)
  private count = 0
  private t0S = 0
  sampleCount = 0
  energyJ = 0

  constructor(private readonly jobId: number) {}

  push(tS: number, xMm: number, yMm: number, dtS: number, speedMmPerS: number, powerW: number, line: number): void {
    if (this.count === 0) this.t0S = tS
    const o = this.count * SAMPLE_FIELD_COUNT
    const f = this.f32
    f[o] = tS - this.t0S
    f[o + 1] = xMm
    f[o + 2] = yMm
    f[o + 3] = dtS
    f[o + 4] = speedMmPerS
    f[o + 5] = powerW
    this.u32[o + 6] = line
    this.energyJ += f[o + 5]! * f[o + 3]!
    this.count++
    this.sampleCount++
    if (this.count === SAMPLE_BATCH_MAX_SAMPLES) this.flush(false)
  }

  flush(last: boolean): void {
    const bytes = SAMPLE_BATCH_HEADER_BYTES + this.count * SAMPLE_STRIDE_BYTES
    const out = this.buf.slice(0, bytes)
    const view = new DataView(out)
    view.setUint32(0, SAMPLE_BATCH_MAGIC, true)
    view.setUint16(4, SAMPLE_BATCH_LAYOUT_VERSION, true)
    view.setUint16(6, SAMPLE_STRIDE_BYTES, true)
    view.setUint32(8, this.count, true)
    view.setUint32(12, this.batches.length, true)
    view.setFloat64(16, this.t0S, true)
    view.setUint32(24, this.jobId, true)
    view.setUint32(28, last ? SAMPLE_FLAG_LAST : 0, true)
    this.batches.push(out)
    this.count = 0
  }

  finish(): void {
    // Always end with a batch carrying the last flag, even an empty one.
    this.flush(true)
  }
}

export const interimSampler: MotionSampler = {
  name: 'interim-trapezoid',
  plan(job, machine, jobId) {
    const segs = segments(job, machine)
    planSpeeds(segs)
    const stepMaxMm = gridPitchMm(machine.spot)
    const writer = new BatchWriter(jobId)
    let tS = 0

    for (const s of segs) {
      const a = s.accel
      // Trapezoid, or triangle when the move is too short to reach vMax.
      let vPeak = s.vMax
      let dAccel = (vPeak ** 2 - s.vEntry ** 2) / (2 * a)
      let dDecel = (vPeak ** 2 - s.vExit ** 2) / (2 * a)
      if (dAccel + dDecel > s.lengthMm) {
        vPeak = Math.sqrt(Math.max(s.vEntry ** 2, s.vExit ** 2, (2 * a * s.lengthMm + s.vEntry ** 2 + s.vExit ** 2) / 2))
        dAccel = Math.max(0, (vPeak ** 2 - s.vEntry ** 2) / (2 * a))
        dDecel = Math.max(0, s.lengthMm - dAccel)
      }
      const dCruise = Math.max(0, s.lengthMm - dAccel - dDecel)
      const blocks: [v0: number, acc: number, dist: number][] = [
        [s.vEntry, a, dAccel],
        [vPeak, 0, dCruise],
        [vPeak, -a, dDecel],
      ]
      const on = beamOn(s.move)
      let offsetMm = 0
      for (const [v0, acc, dist] of blocks) {
        if (dist <= 1e-12) continue
        const v1 = Math.sqrt(Math.max(0, v0 * v0 + 2 * acc * dist))
        const durationS = acc === 0 ? dist / v0 : (v1 - v0) / acc
        if (on && durationS > 0) {
          const n = Math.max(1, Math.ceil(durationS / SAMPLE_DT_MAX_S), Math.ceil(dist / stepMaxMm))
          const dt = durationS / n
          for (let k = 0; k < n; k++) {
            const tm = (k + 0.5) * dt
            const v = v0 + acc * tm
            const along = offsetMm + v0 * tm + 0.5 * acc * tm * tm
            const powerW = opticalPowerW(machine, s.move.s, s.move.laser, v * 60, s.programmedMmPerMin)
            if (powerW > 0) writer.push(tS + tm, s.x0 + s.ux * along, s.y0 + s.uy * along, dt, v, powerW, s.move.line)
          }
        }
        tS += durationS
        offsetMm += dist
      }
    }
    writer.finish()
    return { batches: writer.batches, durationS: tS, sampleCount: writer.sampleCount, energyJ: writer.energyJ }
  },
}

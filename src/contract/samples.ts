// SPDX-License-Identifier: MIT
// Motion samples: the planner's output (Rust, COD-255) and the deposit
// stage's input (TS core, COD-264).
//
// Samples are high volume, so they travel over a Tauri Channel as raw binary
// batches, not JSON. JSON Schema can't describe this layout; the constants below
// are the contract and are exported to `schema/sample-batch-layout.json` so the
// Rust side can assert against the same numbers.
//
// Sampling rule (normative):
//   - Only beam-on time is sampled (optical power > 0). Gaps between samples are
//     beam-off time; `t` stays on the job clock so scrub cutoffs are exact.
//   - Each planner block (constant acceleration) of duration T and length L is
//     split into n = max(1, ceil(T / SAMPLE_DT_MAX_S), ceil(L / stepMaxMm))
//     equal-time intervals, where stepMaxMm = gridPitchMm (spot ÷ 3, see deposit.ts).
//   - One sample per interval, taken at the interval midpoint (t, x, y, speed,
//     power all at the midpoint), with dt = T / n. Midpoint sampling is exact for
//     energy under constant acceleration, for both M3 and M4.
//   - Energy carried by a sample is powerW × dtS (J). Absorption is applied by the
//     core, not the planner.

/** 'ABS1' as little-endian u32. */
export const SAMPLE_BATCH_MAGIC = 0x3153_4241
export const SAMPLE_BATCH_LAYOUT_VERSION = 1
export const SAMPLE_BATCH_HEADER_BYTES = 32
export const SAMPLE_BATCH_MAX_SAMPLES = 16_384
export const SAMPLE_DT_MAX_S = 0.0005

/** Header fields, all little-endian. */
export const SAMPLE_BATCH_HEADER = [
  { name: 'magic', offset: 0, type: 'u32', description: 'SAMPLE_BATCH_MAGIC' },
  { name: 'layoutVersion', offset: 4, type: 'u16', description: 'SAMPLE_BATCH_LAYOUT_VERSION' },
  { name: 'strideBytes', offset: 6, type: 'u16', description: 'Bytes per sample (SAMPLE_STRIDE_BYTES)' },
  { name: 'sampleCount', offset: 8, type: 'u32', description: 'Samples in this batch (<= SAMPLE_BATCH_MAX_SAMPLES)' },
  { name: 'sequence', offset: 12, type: 'u32', description: '0-based batch index within the job, contiguous' },
  { name: 't0S', offset: 16, type: 'f64', description: 'Batch time origin, seconds since job start' },
  { name: 'jobId', offset: 24, type: 'u32', description: 'Job this batch belongs to (job.loaded jobId)' },
  { name: 'flags', offset: 28, type: 'u32', description: 'Bit 0: last batch of the job. Other bits reserved, 0.' },
] as const

export const SAMPLE_FLAG_LAST = 1

/**
 * Per-sample fields, interleaved, 4 bytes each, little-endian, in this order.
 * `tRelS` is relative to the header's t0S so f32 keeps sub-microsecond precision
 * in long jobs. `line` is a u32 sharing the same 4-byte slot width, so one
 * ArrayBuffer is read through a Float32Array and a Uint32Array view.
 */
export const SAMPLE_FIELDS = [
  { name: 'tRelS', type: 'f32', unit: 's', description: 'Sample time (interval midpoint) minus t0S' },
  { name: 'xMm', type: 'f32', unit: 'mm', description: 'Absolute X at the sample' },
  { name: 'yMm', type: 'f32', unit: 'mm', description: 'Absolute Y at the sample' },
  { name: 'dtS', type: 'f32', unit: 's', description: 'Interval duration this sample stands for (energy weight)' },
  { name: 'speedMmPerS', type: 'f32', unit: 'mm/s', description: 'Actual planner speed at the sample' },
  { name: 'powerW', type: 'f32', unit: 'W', description: 'Actual optical power: after M4 scaling and the S → power curve' },
  { name: 'line', type: 'u32', unit: '', description: '1-based source line of the move being executed' },
] as const

export const SAMPLE_FIELD_COUNT = SAMPLE_FIELDS.length
export const SAMPLE_STRIDE_BYTES = SAMPLE_FIELD_COUNT * 4

export type SampleFieldName = (typeof SAMPLE_FIELDS)[number]['name']
export const SAMPLE_FIELD_INDEX = Object.fromEntries(SAMPLE_FIELDS.map((f, i) => [f.name, i])) as Record<
  SampleFieldName,
  number
>

export interface MotionSample {
  tRelS: number
  xMm: number
  yMm: number
  dtS: number
  speedMmPerS: number
  powerW: number
  line: number
}

export interface SampleBatchHeader {
  sampleCount: number
  sequence: number
  t0S: number
  jobId: number
  last: boolean
}

/** Zero-copy view over a received batch. */
export interface SampleBatchView extends SampleBatchHeader {
  /** Interleaved f32 fields; index sample i, field f at [i * SAMPLE_FIELD_COUNT + f]. */
  f32: Float32Array
  /** Same memory as u32, for the `line` field. */
  u32: Uint32Array
}

export function decodeSampleBatch(buffer: ArrayBuffer, byteOffset = 0): SampleBatchView {
  const view = new DataView(buffer, byteOffset)
  if (view.byteLength < SAMPLE_BATCH_HEADER_BYTES) throw new Error('sample batch: shorter than header')
  const magic = view.getUint32(0, true)
  if (magic !== SAMPLE_BATCH_MAGIC) throw new Error(`sample batch: bad magic 0x${magic.toString(16)}`)
  const version = view.getUint16(4, true)
  if (version !== SAMPLE_BATCH_LAYOUT_VERSION) throw new Error(`sample batch: unsupported layout version ${version}`)
  const stride = view.getUint16(6, true)
  if (stride !== SAMPLE_STRIDE_BYTES) throw new Error(`sample batch: stride ${stride}, expected ${SAMPLE_STRIDE_BYTES}`)
  const sampleCount = view.getUint32(8, true)
  if (sampleCount > SAMPLE_BATCH_MAX_SAMPLES) throw new Error(`sample batch: ${sampleCount} samples exceeds max`)
  const expected = SAMPLE_BATCH_HEADER_BYTES + sampleCount * stride
  if (view.byteLength < expected) throw new Error(`sample batch: ${view.byteLength} bytes, expected ${expected}`)
  const bodyOffset = byteOffset + SAMPLE_BATCH_HEADER_BYTES
  const words = sampleCount * SAMPLE_FIELD_COUNT
  return {
    sampleCount,
    sequence: view.getUint32(12, true),
    t0S: view.getFloat64(16, true),
    jobId: view.getUint32(24, true),
    last: (view.getUint32(28, true) & SAMPLE_FLAG_LAST) !== 0,
    f32: new Float32Array(buffer, bodyOffset, words),
    u32: new Uint32Array(buffer, bodyOffset, words),
  }
}

export function encodeSampleBatch(header: Omit<SampleBatchHeader, 'sampleCount'>, samples: readonly MotionSample[]): ArrayBuffer {
  if (samples.length > SAMPLE_BATCH_MAX_SAMPLES) throw new Error('sample batch: too many samples')
  const buffer = new ArrayBuffer(SAMPLE_BATCH_HEADER_BYTES + samples.length * SAMPLE_STRIDE_BYTES)
  const view = new DataView(buffer)
  view.setUint32(0, SAMPLE_BATCH_MAGIC, true)
  view.setUint16(4, SAMPLE_BATCH_LAYOUT_VERSION, true)
  view.setUint16(6, SAMPLE_STRIDE_BYTES, true)
  view.setUint32(8, samples.length, true)
  view.setUint32(12, header.sequence, true)
  view.setFloat64(16, header.t0S, true)
  view.setUint32(24, header.jobId, true)
  view.setUint32(28, header.last ? SAMPLE_FLAG_LAST : 0, true)
  samples.forEach((s, i) => {
    const o = SAMPLE_BATCH_HEADER_BYTES + i * SAMPLE_STRIDE_BYTES
    view.setFloat32(o, s.tRelS, true)
    view.setFloat32(o + 4, s.xMm, true)
    view.setFloat32(o + 8, s.yMm, true)
    view.setFloat32(o + 12, s.dtS, true)
    view.setFloat32(o + 16, s.speedMmPerS, true)
    view.setFloat32(o + 20, s.powerW, true)
    view.setUint32(o + 24, s.line, true)
  })
  return buffer
}

export function readSample(batch: SampleBatchView, i: number): MotionSample {
  const o = i * SAMPLE_FIELD_COUNT
  return {
    tRelS: batch.f32[o]!,
    xMm: batch.f32[o + 1]!,
    yMm: batch.f32[o + 2]!,
    dtS: batch.f32[o + 3]!,
    speedMmPerS: batch.f32[o + 4]!,
    powerW: batch.f32[o + 5]!,
    line: batch.u32[o + 6]!,
  }
}

/** Layout as data, exported for the Rust side's conformance test. */
export const SAMPLE_BATCH_LAYOUT = {
  endianness: 'little',
  magic: SAMPLE_BATCH_MAGIC,
  layoutVersion: SAMPLE_BATCH_LAYOUT_VERSION,
  headerBytes: SAMPLE_BATCH_HEADER_BYTES,
  header: SAMPLE_BATCH_HEADER,
  strideBytes: SAMPLE_STRIDE_BYTES,
  fields: SAMPLE_FIELDS,
  maxSamples: SAMPLE_BATCH_MAX_SAMPLES,
  flags: { last: SAMPLE_FLAG_LAST },
  sampling: { dtMaxS: SAMPLE_DT_MAX_S, stepMax: 'gridPitchMm', point: 'interval-midpoint' },
} as const

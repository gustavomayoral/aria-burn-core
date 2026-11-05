// SPDX-License-Identifier: MIT
// A bounded window of a big per-sample array on the GPU (BURN-38).
//
// The per-sample arrays (the store's samples, the spatial bins, the thermal
// step's statics) grow with the job: ~20 M samples for a 100 mm raster at the
// provisional diode's pitch. As whole vertex buffers they cost the WebView2 GPU
// process far more than their size on ANGLE / Direct3D 11 (Windows), which the
// GPU byte budget never saw:
//   - a STATIC_DRAW buffer costs twice its size once drawn from (ANGLE keeps a
//     staging copy beside the vertex buffer);
//   - a DYNAMIC_DRAW buffer isn't bound directly: every draw streams the range
//     it reads into a streaming buffer that the driver renames under load, so a
//     pass over millions of samples piles up copies (~1 GB over the resting size
//     in the 5 µm job's thermal step, ~1.2 GB in its full run).
// On Iris Xe the GPU process then lost its context (BURN-38). A window holds a
// contiguous range of items in one STATIC_DRAW buffer of bounded size and is
// refilled from the CPU array as draws move on. Draws walk their arrays in
// order (bins by bucket row, the thermal step by time bin, coarse runs by
// checkpoint), so each item is uploaded about once per pass. A draw that spans
// the window's end is split into consecutive draws, which keeps primitive order
// and so the blended result.
//
// Elsewhere (Metal on Apple silicon, discrete GPUs) the window can hold the
// whole array (`whole`): uploaded once, then appended to as a live job grows,
// as the plain vertex buffers before it were, so runs re-upload nothing.

import { trackBuffer } from './gl-util.ts'

/** Items a window holds unless one atomic range needs more: 2 M samples (24–48 MiB at 12–24 B an item). */
export const VERTEX_WINDOW_ITEMS = 1 << 21

/** Writes items [from, to) of the source into `dst`, item `from` at byte 0. */
export type WindowFill = (dst: ArrayBuffer, from: number, to: number) => void

/**
 * Whether per-sample vertex data should go through bounded windows on this
 * GPU (by its WebGL renderer string): on ANGLE / Direct3D 11 (every browser
 * and WebView2 on Windows) and on Intel integrated GPUs, where it is measured
 * (BURN-38) or the memory is shared with the system.
 */
export function windowedVertexData(renderer: string): boolean {
  return /direct3d|d3d11|intel|iris|uhd graphics|hd graphics/i.test(renderer)
}

export class VertexWindow {
  readonly buffer: WebGLBuffer
  /** Items held: [from, to) of the source last filled. */
  from = 0
  to = 0
  private cap = 0
  private scratch = new ArrayBuffer(0)
  private source: object | null = null
  private version = -1

  constructor(
    private readonly gl: WebGL2RenderingContext,
    /** Bytes per item (the vertex stride). */
    readonly itemBytes: number,
    /**
     * Hold the whole array instead of a window. A source then may only change
     * by appending items (a SampleStore; SampleBins never change).
     */
    readonly whole = false,
    readonly minItems = VERTEX_WINDOW_ITEMS,
  ) {
    this.buffer = gl.createBuffer()!
  }

  /** GPU bytes the window has now. */
  get bytes(): number {
    return this.cap * this.itemBytes
  }

  /** More GPU bytes it will take to draw a source of `count` items (for budget estimates). */
  pendingBytes(count: number): number {
    if (this.whole) return Math.max(0, count - this.cap) * this.itemBytes
    return this.cap ? 0 : this.minItems * this.itemBytes
  }

  /**
   * Hold items [lo, hi) of `source` (as of `version`; `count` items in all).
   * When they aren't all held, refill from lo with as many as fit (up to
   * `count`), growing only if hi − lo is more than the window holds. Leaves
   * the buffer bound to ARRAY_BUFFER and returns the first item held: item i
   * is at byte (i − returned) · itemBytes.
   */
  hold(source: object, version: number, lo: number, hi: number, count: number, fill: WindowFill): number {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    if (source === this.source && version === this.version && lo >= this.from && hi <= this.to) return this.from
    if (this.whole) return this.holdWhole(source, version, count, fill)
    if (hi - lo > this.cap) {
      // STATIC_DRAW: bound directly by ANGLE D3D11 (a DYNAMIC_DRAW buffer is streamed on every draw).
      this.cap = Math.max(this.minItems, hi - lo)
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * this.itemBytes, gl.STATIC_DRAW)
      trackBuffer(gl, this.buffer, this.cap * this.itemBytes)
      this.scratch = new ArrayBuffer(this.cap * this.itemBytes)
    }
    const to = Math.max(hi, Math.min(count, lo + this.cap))
    fill(this.scratch, lo, to)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(this.scratch, 0, (to - lo) * this.itemBytes))
    this.source = source
    this.version = version
    this.from = lo
    this.to = to
    return lo
  }

  /** Whole mode: upload what isn't on the GPU yet (only the appended items when the source just grew). */
  private holdWhole(source: object, version: number, count: number, fill: WindowFill): number {
    const gl = this.gl
    let from = source === this.source ? this.to : 0
    if (count > this.cap) {
      // Live jobs grow: leave headroom so appends don't reallocate (and re-upload) every time.
      this.cap = Math.max(count, Math.ceil(this.cap * 1.5), 4096)
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * this.itemBytes, gl.STATIC_DRAW)
      trackBuffer(gl, this.buffer, this.cap * this.itemBytes)
      from = 0
    }
    if (count > from) {
      const data = new ArrayBuffer((count - from) * this.itemBytes)
      fill(data, from, count)
      gl.bufferSubData(gl.ARRAY_BUFFER, from * this.itemBytes, new Uint8Array(data))
    }
    this.source = source
    this.version = version
    this.from = 0
    this.to = count
    return 0
  }

  /** Forget what it holds (the source changed in place). */
  invalidate(): void {
    this.source = null
    this.from = this.to = 0
  }

  /** Free the buffer's storage; the next hold reallocates it. */
  release(): void {
    this.invalidate()
    if (!this.cap) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW)
    trackBuffer(gl, this.buffer, 0)
    this.cap = 0
    this.scratch = new ArrayBuffer(0)
  }

  dispose(): void {
    this.release()
    this.gl.deleteBuffer(this.buffer)
  }
}

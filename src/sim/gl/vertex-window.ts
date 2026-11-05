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

import { trackBuffer } from './gl-util.ts'

/** Items a window holds unless one atomic range needs more: 2 M samples (24–48 MiB at 12–24 B an item). */
export const VERTEX_WINDOW_ITEMS = 1 << 21

/** Writes items [from, to) of the source into `dst`, item `from` at byte 0. */
export type WindowFill = (dst: ArrayBuffer, from: number, to: number) => void

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
    readonly minItems = VERTEX_WINDOW_ITEMS,
  ) {
    this.buffer = gl.createBuffer()!
  }

  /** GPU bytes the window has now. */
  get bytes(): number {
    return this.cap * this.itemBytes
  }

  /** GPU bytes it will have once used, if it isn't yet (for budget estimates). */
  get pendingBytes(): number {
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

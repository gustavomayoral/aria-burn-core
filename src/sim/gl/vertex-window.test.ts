// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { VertexWindow, windowedVertexData } from './vertex-window.ts'

/** Just enough of WebGL2 for VertexWindow, recording what reaches the buffer. */
function fakeGl() {
  const calls: string[] = []
  let size = 0
  let bytes = new Uint8Array(0)
  const gl = {
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    createBuffer: () => ({}),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: (_t: number, n: number) => {
      size = n
      bytes = new Uint8Array(n)
      calls.push(`alloc ${n}`)
    },
    bufferSubData: (_t: number, offset: number, data: Uint8Array) => {
      bytes.set(data, offset)
      calls.push(`upload ${offset}+${data.byteLength}`)
    },
  }
  return { gl: gl as unknown as WebGL2RenderingContext, calls, item: (i: number) => new Float32Array(bytes.buffer, i * 4, 1)[0], size: () => size }
}

/** A source of `count` 4-byte items whose value is their index. */
const fill = (dst: ArrayBuffer, from: number, to: number) => {
  const f = new Float32Array(dst, 0, to - from)
  for (let i = from; i < to; i++) f[i - from] = i
}

describe('VertexWindow (BURN-38)', () => {
  it('holds a bounded window and refills it from the first item asked for', () => {
    const { gl, calls, item } = fakeGl()
    const w = new VertexWindow(gl, 4, false, 100)
    const src = {}
    expect(w.hold(src, 1, 0, 1, 1000, fill)).toBe(0)
    expect([w.from, w.to]).toEqual([0, 100])
    expect(w.hold(src, 1, 50, 100, 1000, fill)).toBe(0)
    expect(calls).toEqual(['alloc 400', 'upload 0+400'])
    // Past the end: refill from 120, as many as fit.
    expect(w.hold(src, 1, 120, 121, 1000, fill)).toBe(120)
    expect([w.from, w.to]).toEqual([120, 220])
    expect(item(0)).toBe(120)
    // Near the source's end: only what is left.
    expect(w.hold(src, 1, 950, 951, 1000, fill)).toBe(950)
    expect(w.to).toBe(1000)
    expect(w.bytes).toBe(400)
  })

  it('grows only for an atomic range wider than the window, and refills on a new version or source', () => {
    const { gl, calls } = fakeGl()
    const w = new VertexWindow(gl, 4, false, 100)
    const src = {}
    w.hold(src, 1, 0, 150, 1000, fill)
    expect([w.from, w.to, w.bytes]).toEqual([0, 150, 600])
    calls.length = 0
    w.hold(src, 2, 10, 20, 1000, fill)
    w.hold({}, 2, 10, 20, 1000, fill)
    expect(calls).toEqual(['upload 0+600', 'upload 0+600'])
    expect(w.pendingBytes(1e6)).toBe(0)
    w.release()
    expect(w.bytes).toBe(0)
    expect(w.pendingBytes(1e6)).toBe(400)
  })

  it('whole mode uploads everything once, then only appended items', () => {
    const { gl, calls, item } = fakeGl()
    const w = new VertexWindow(gl, 4, true)
    const store = {}
    expect(w.hold(store, 1, 5, 6, 10_000, fill)).toBe(0)
    expect(calls).toEqual(['alloc 40000', 'upload 0+40000'])
    expect(w.hold(store, 1, 0, 10_000, 10_000, fill)).toBe(0)
    calls.length = 0
    // Grown past the buffer: reallocated with headroom (15 000 items) and uploaded again.
    w.hold(store, 2, 10_500, 10_501, 12_000, fill)
    expect(calls).toEqual(['alloc 60000', 'upload 0+48000'])
    calls.length = 0
    // Grown within the headroom: just the new items.
    expect(w.hold(store, 3, 13_000, 13_001, 14_000, fill)).toBe(0)
    expect(calls).toEqual(['upload 48000+8000'])
    expect(item(13_999)).toBe(13_999)
    expect(w.pendingBytes(14_000)).toBe(0)
    expect(w.pendingBytes(20_000)).toBe(5000 * 4)
  })

  it('windows vertex data on Direct3D and Intel renderers only', () => {
    expect(windowedVertexData('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(windowedVertexData('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true)
    expect(windowedVertexData('Apple GPU')).toBe(false)
    expect(windowedVertexData('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)')).toBe(false)
  })
})

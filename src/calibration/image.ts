// SPDX-License-Identifier: MIT
// Image and geometry helpers for the photo fit (BURN-15): an RGBA8 photo,
// planar homographies (4-point DLT and least squares), and bilinear sampling.
// Plain arrays, no DOM: the app decodes the photo to RGBA (canvas) and hands
// it here, so detection and fitting run the same in Vitest.

export interface Photo {
  width: number
  height: number
  /** RGBA8, row 0 = top of the picture, sRGB-encoded as a camera writes it. */
  data: Uint8ClampedArray
}

export interface Point {
  x: number
  y: number
}

/** 3×3 row-major homography: [x', y', w'] = H · [x, y, 1]. */
export type Homography = Float64Array

export function applyH(h: Homography, x: number, y: number): Point {
  const w = h[6]! * x + h[7]! * y + h[8]!
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w }
}

export function invertH(h: Homography): Homography {
  const [a, b, c, d, e, f, g, k, l] = h as unknown as number[]
  const A = e! * l! - f! * k!
  const B = -(d! * l! - f! * g!)
  const C = d! * k! - e! * g!
  const det = a! * A + b! * B + c! * C
  const inv = new Float64Array([
    A,
    -(b! * l! - c! * k!),
    b! * f! - c! * e!,
    B,
    a! * l! - c! * g!,
    -(a! * f! - c! * d!),
    C,
    -(a! * k! - b! * g!),
    a! * e! - b! * d!,
  ])
  for (let i = 0; i < 9; i++) inv[i]! /= det
  return inv
}

/** Solve A x = b (n×n, row-major) by Gaussian elimination with partial pivoting; null if singular. */
export function solveLinear(A: Float64Array | number[], b: Float64Array | number[], n: number): Float64Array | null {
  const m = new Float64Array(n * (n + 1))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) m[i * (n + 1) + j] = A[i * n + j]!
    m[i * (n + 1) + n] = b[i]!
  }
  const w = n + 1
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * w + c]!) > Math.abs(m[p * w + c]!)) p = r
    if (Math.abs(m[p * w + c]!) < 1e-14) return null
    if (p !== c) for (let j = 0; j < w; j++) [m[c * w + j], m[p * w + j]] = [m[p * w + j]!, m[c * w + j]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r * w + c]! / m[c * w + c]!
      if (f === 0) continue
      for (let j = c; j < w; j++) m[r * w + j]! -= f * m[c * w + j]!
    }
  }
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = m[i * w + n]! / m[i * w + i]!
  return x
}

/**
 * Homography mapping `src[i]` to `dst[i]` (≥ 4 pairs, least squares with
 * h₈ = 1, after normalising both point sets for conditioning).
 */
export function fitHomography(src: readonly Point[], dst: readonly Point[]): Homography {
  if (src.length < 4 || src.length !== dst.length) throw new Error('fitHomography needs ≥ 4 point pairs')
  const norm = (pts: readonly Point[]) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
    const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1
    const s = Math.SQRT2 / d
    return { s, cx, cy, pts: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })) }
  }
  const S = norm(src)
  const T = norm(dst)
  // Normal equations of the 8-unknown linear system.
  const ata = new Float64Array(64)
  const atb = new Float64Array(8)
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      atb[i]! += row[i]! * rhs
      for (let j = 0; j < 8; j++) ata[i * 8 + j]! += row[i]! * row[j]!
    }
  }
  for (let i = 0; i < S.pts.length; i++) {
    const { x, y } = S.pts[i]!
    const { x: u, y: v } = T.pts[i]!
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u)
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v)
  }
  const h = solveLinear(ata, atb, 8)
  if (!h) throw new Error('fitHomography: degenerate points')
  const Hn = new Float64Array([h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1])
  // H = T⁻¹ · Hn · S
  const Sm = new Float64Array([S.s, 0, -S.s * S.cx, 0, S.s, -S.s * S.cy, 0, 0, 1])
  const Ti = new Float64Array([1 / T.s, 0, T.cx, 0, 1 / T.s, T.cy, 0, 0, 1])
  return mul3(Ti, mul3(Hn, Sm))
}

export function mul3(a: Homography, b: Homography): Homography {
  const o = new Float64Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!
  return o
}

/** Linear RGB at a photo point, bilinear over the decoded pixels (pixel centres at +0.5). */
export function sampleLinear(photo: Photo, lin: Float32Array, x: number, y: number, out: [number, number, number]): boolean {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  if (x0 < 0 || y0 < 0 || x0 + 1 >= photo.width || y0 + 1 >= photo.height) return false
  const ax = fx - x0
  const ay = fy - y0
  const w = photo.width
  for (let c = 0; c < 3; c++) {
    const p00 = lin[(y0 * w + x0) * 3 + c]!
    const p10 = lin[(y0 * w + x0 + 1) * 3 + c]!
    const p01 = lin[((y0 + 1) * w + x0) * 3 + c]!
    const p11 = lin[((y0 + 1) * w + x0 + 1) * 3 + c]!
    out[c] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay
  }
  return true
}

/** The photo decoded to linear sRGB, 3 floats per pixel. */
export function decodePhoto(photo: Photo, lut: Float32Array): Float32Array {
  const n = photo.width * photo.height
  const out = new Float32Array(n * 3)
  const d = photo.data
  for (let i = 0; i < n; i++) {
    out[i * 3] = lut[d[i * 4]!]!
    out[i * 3 + 1] = lut[d[i * 4 + 1]!]!
    out[i * 3 + 2] = lut[d[i * 4 + 2]!]!
  }
  return out
}

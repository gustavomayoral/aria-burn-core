// SPDX-License-Identifier: MIT
// Blur kernels (COD-250 §2, COD-256): an elliptical Gaussian with
// σ_total = √(σ_spot² + σ_heat²) per spot axis, rotated by the spot angle,
// truncated at KERNEL_RADIUS_SIGMAS and normalised by its discrete sum so blur
// conserves Σ fluence · pitch².
//
// It runs as two 1D passes (contract shearedKernel): along machine X, then
// along Y. For an axis-aligned spot (the provisional diode is at 90°) that is
// a plain separable blur. For a rotated spot the Y pass is sheared: the tap at
// row offset t reads at x + shear·t, split linearly over the two nearest
// cells. The split keeps each tap's mean but adds f(1 − f) cells² of X
// variance, so the X pass is narrowed by the tap-weighted mean of that.

import { KERNEL_RADIUS_SIGMAS, kernelRadiusMm, shearedKernel, type KernelSigma } from '../contract/index.ts'

export interface Kernel1D {
  sigmaCells: number
  radius: number
  /** 2·radius + 1 weights summing to 1, centre at index radius. */
  weights: Float32Array
}

/** Per-tap X offsets of the sheared Y pass; tap t reads cells x + offset and x + offset + 1. */
export interface SkewTaps {
  /** X cells per Y cell. */
  shear: number
  offset: Int32Array
  /** weight · (1 − frac), read at x + offset. */
  w0: Float32Array
  /** weight · frac, read at x + offset + 1. */
  w1: Float32Array
}

export interface SeparableKernel {
  x: Kernel1D
  /** Y pass. With `skew`, these are the per-row tap weights before the linear split. */
  y: Kernel1D
  /** Null for axis-aligned kernels, where the Y pass is a plain 1D blur. */
  skew: SkewTaps | null
}

function gaussian(sigmaCells: number, radius: number): Kernel1D {
  const w = new Float64Array(2 * radius + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = sigmaCells > 0 ? Math.exp(-(i * i) / (2 * sigmaCells * sigmaCells)) : i === 0 ? 1 : 0
    w[i + radius] = v
    sum += v
  }
  const weights = new Float32Array(w.length)
  for (let i = 0; i < w.length; i++) weights[i] = w[i]! / sum
  return { sigmaCells, radius, weights }
}

export function kernel1D(sigmaCells: number): Kernel1D {
  return gaussian(sigmaCells, Math.max(0, Math.ceil(KERNEL_RADIUS_SIGMAS * sigmaCells)))
}

export function separableKernel(kernel: KernelSigma, pitchMm: number): SeparableKernel {
  const { sigmaXMm, sigmaYMm, shear } = shearedKernel(kernel)
  const sx = sigmaXMm / pitchMm
  const sy = sigmaYMm / pitchMm
  if (shear === 0) return { x: kernel1D(sx), y: kernel1D(sy), skew: null }

  // Keep the whole footprint inside the tile margin so tiled output still
  // matches untiled: drop end rows whose sheared read would reach past it.
  const margin = Math.ceil(kernelRadiusMm(kernel) / pitchMm)
  const xReach = Math.ceil(KERNEL_RADIUS_SIGMAS * sx)
  let radius = Math.max(0, Math.ceil(KERNEL_RADIUS_SIGMAS * sy))
  while (radius > 0 && Math.ceil(Math.abs(shear * radius)) + xReach > margin) radius--
  const y = gaussian(sy, radius)

  const n = 2 * radius + 1
  const offset = new Int32Array(n)
  const w0 = new Float32Array(n)
  const w1 = new Float32Array(n)
  let interpVar = 0
  for (let t = -radius; t <= radius; t++) {
    const at = shear * t
    const k = Math.floor(at)
    const f = at - k
    const w = y.weights[t + radius]!
    offset[t + radius] = k
    w0[t + radius] = w * (1 - f)
    w1[t + radius] = w * f
    interpVar += w * f * (1 - f)
  }
  const x = kernel1D(Math.sqrt(Math.max(0, sx * sx - interpVar)))
  return { x, y, skew: { shear, offset, w0, w1 } }
}

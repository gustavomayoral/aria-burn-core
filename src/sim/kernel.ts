// SPDX-License-Identifier: MIT
// Separable blur kernels (COD-250 §2): one Gaussian with
// σ_total = √(σ_spot² + σ_heat²), truncated at KERNEL_RADIUS_SIGMAS and
// normalised by its discrete sum so blur conserves Σ fluence · pitch².
//
// The blur runs along machine X then Y. That is exact when the spot axes are
// machine-aligned (angleDeg a multiple of 90°, as on the provisional diode).
// For other angles it keeps the kernel's variance along X and Y but drops the
// X–Y correlation; the rotated elliptical kernel is COD-256.

import { KERNEL_RADIUS_SIGMAS, type KernelSigma } from '../contract/index.ts'

export interface Kernel1D {
  sigmaCells: number
  radius: number
  /** 2·radius + 1 weights summing to 1, centre at index radius. */
  weights: Float32Array
}

export interface SeparableKernel {
  x: Kernel1D
  y: Kernel1D
  /** True when the separable X/Y kernel equals the requested one (axis-aligned spot). */
  exact: boolean
}

export function kernel1D(sigmaCells: number): Kernel1D {
  const radius = Math.max(0, Math.ceil(KERNEL_RADIUS_SIGMAS * sigmaCells))
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

/** Machine-axis sigmas (mm) of the kernel: the diagonal of its rotated covariance. */
export function axisSigmasMm(kernel: KernelSigma): { sigmaXMm: number; sigmaYMm: number; exact: boolean } {
  const a = (kernel.angleDeg * Math.PI) / 180
  const c2 = Math.cos(a) ** 2
  const s2 = Math.sin(a) ** 2
  const u2 = kernel.sigmaUMm ** 2
  const v2 = kernel.sigmaVMm ** 2
  const exact = Math.min(c2, s2) < 1e-9 || Math.abs(u2 - v2) < 1e-15
  return { sigmaXMm: Math.sqrt(u2 * c2 + v2 * s2), sigmaYMm: Math.sqrt(u2 * s2 + v2 * c2), exact }
}

export function separableKernel(kernel: KernelSigma, pitchMm: number): SeparableKernel {
  const { sigmaXMm, sigmaYMm, exact } = axisSigmasMm(kernel)
  return { x: kernel1D(sigmaXMm / pitchMm), y: kernel1D(sigmaYMm / pitchMm), exact }
}

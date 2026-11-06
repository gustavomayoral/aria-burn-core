// SPDX-License-Identifier: MIT
// Damped least squares (Levenberg–Marquardt) with a forward-difference
// Jacobian, for the photo fit (BURN-15). Small problems only: tens of
// parameters, a few hundred residuals.

import { solveLinear } from './image.ts'

export interface LmOptions {
  maxIterations?: number
  /** Relative step on each parameter for the numeric Jacobian. */
  diffStep?: number
  /** Stop when the cost improves by less than this fraction. */
  tolerance?: number
  /** Floor on the residual variance s² used for the covariance. */
  noiseVariance?: number
}

export interface LmResult {
  p: Float64Array
  cost: number
  iterations: number
  /** (JᵀJ)⁻¹ · s² at the solution (row-major), null if singular; s² = max(cost / (m − n), noiseVariance). */
  covariance: Float64Array | null
}

const sumSq = (r: Float64Array) => r.reduce((s, v) => s + v * v, 0)

export function levenbergMarquardt(residuals: (p: Float64Array) => Float64Array, p0: Float64Array, options: LmOptions = {}): LmResult {
  const maxIt = options.maxIterations ?? 100
  const h = options.diffStep ?? 1e-4
  const tol = options.tolerance ?? 1e-10
  const n = p0.length
  let p = Float64Array.from(p0)
  let r = residuals(p)
  let cost = sumSq(r)
  const m = r.length
  let lambda = 1e-3
  let it = 0
  let J = new Float64Array(m * n)
  const jacobian = () => {
    J = new Float64Array(m * n)
    for (let j = 0; j < n; j++) {
      const q = Float64Array.from(p)
      const d = h * Math.max(1, Math.abs(p[j]!))
      q[j]! += d
      const rq = residuals(q)
      for (let i = 0; i < m; i++) J[i * n + j] = (rq[i]! - r[i]!) / d
    }
  }
  const normal = () => {
    const A = new Float64Array(n * n)
    const g = new Float64Array(n)
    for (let i = 0; i < m; i++) {
      const ri = r[i]!
      for (let a = 0; a < n; a++) {
        const ja = J[i * n + a]!
        if (ja === 0) continue
        g[a]! += ja * ri
        for (let b = a; b < n; b++) A[a * n + b]! += ja * J[i * n + b]!
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a]!
    return { A, g }
  }
  jacobian()
  for (; it < maxIt; it++) {
    const { A, g } = normal()
    let improved = false
    for (let tries = 0; tries < 12; tries++) {
      const M = Float64Array.from(A)
      for (let a = 0; a < n; a++) M[a * n + a]! += lambda * Math.max(A[a * n + a]!, 1e-12)
      const step = solveLinear(M, g.map((v) => -v), n)
      if (!step) {
        lambda *= 10
        continue
      }
      const q = p.map((v, i) => v + step[i]!)
      const rq = residuals(q)
      const cq = sumSq(rq)
      if (Number.isFinite(cq) && cq < cost) {
        const rel = (cost - cq) / Math.max(cost, 1e-300)
        p = q
        r = rq
        cost = cq
        lambda = Math.max(lambda / 3, 1e-9)
        improved = true
        if (rel < tol) it = maxIt
        break
      }
      lambda *= 8
    }
    if (!improved) break
    if (it < maxIt) jacobian()
  }
  // Covariance at the solution.
  jacobian()
  const { A } = normal()
  let covariance: Float64Array | null = null
  const s2 = Math.max(cost / Math.max(1, m - n), options.noiseVariance ?? 0)
  const inv = new Float64Array(n * n)
  let ok = true
  for (let c = 0; c < n && ok; c++) {
    const e = new Float64Array(n)
    e[c] = 1
    const col = solveLinear(A, e, n)
    if (!col) ok = false
    else for (let i = 0; i < n; i++) inv[i * n + c] = col[i]! * s2
  }
  if (ok) covariance = inv
  return { p, cost, iterations: it, covariance }
}

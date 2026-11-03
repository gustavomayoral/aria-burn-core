// SPDX-License-Identifier: MIT
// COD-256 acceptance (synthetic; real-burn patterns move to COD-254): the
// elliptical spot kernel conserves energy and rotates correctly, raster
// direction changes line width and striping as expected, and S maps to
// optical power through the machine profile's curve.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONSERVATION_TOLERANCE,
  CONTRACT_VERSION,
  decodeSampleBatch,
  interpolateCurve,
  kernelRadiusMm,
  kernelSigma,
  type JobModel,
  type KernelSigma,
  type MachineProfile,
  type Move,
} from '../contract/index.ts'
import {
  CellReader,
  SampleStore,
  blurCpu,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  separableKernel,
  setupJob,
  simulateCpu,
  stitch,
  type SimSetup,
} from './index.ts'
import { rasterJob, squareJob } from './test-jobs.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
const wood = loadMaterialProfile(provisional('birch-ply.json'))

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30)
const deg = (r: number) => (r * 180) / Math.PI

function storeFor(job: JobModel, m: MachineProfile): SampleStore {
  const store = new SampleStore(1)
  for (const b of interimSampler.plan(job, m, 1).batches) store.append(decodeSampleBatch(b))
  return store
}

/** Analytic covariance of a kernel in machine axes (mm²). */
function covariance(k: KernelSigma): { xx: number; yy: number; xy: number } {
  const r = (k.angleDeg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const u2 = k.sigmaUMm ** 2
  const v2 = k.sigmaVMm ** 2
  return { xx: u2 * c * c + v2 * s * s, yy: u2 * s * s + v2 * c * c, xy: (u2 - v2) * c * s }
}

/** Blur one unit impulse at the centre of a square buffer; returns the buffer and its size. */
function impulse(k: KernelSigma, pitchMm: number): { data: Float32Array; n: number } {
  const half = Math.ceil(kernelRadiusMm(k) / pitchMm) + 2
  const n = 2 * half + 1
  const data = new Float32Array(n * n)
  data[half * n + half] = 1
  return { data: blurCpu(data, n, n, separableKernel(k, pitchMm)).afterV, n }
}

/** Sum, mean and second moments of an image (cells). */
function moments(data: Float32Array, n: number) {
  let sum = 0
  let mx = 0
  let my = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = data[y * n + x]!
      sum += v
      mx += v * x
      my += v * y
    }
  mx /= sum
  my /= sum
  let xx = 0
  let yy = 0
  let xy = 0
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = data[y * n + x]! / sum
      xx += v * (x - mx) ** 2
      yy += v * (y - my) ** 2
      xy += v * (x - mx) * (y - my)
    }
  // Principal (major) axis angle, degrees CCW from +X.
  const angle = deg(0.5 * Math.atan2(2 * xy, xx - yy))
  return { sum, mx, my, xx, yy, xy, angle }
}

/** Fold an angle difference into (−90°, 90°]: an ellipse axis has no direction. */
const axisDiff = (a: number, b: number) => {
  let d = (((a - b) % 180) + 180) % 180
  if (d > 90) d -= 180
  return d
}

const ANGLES = [0, 15, 30, 45, 60, 90, 120, 135, 180, -30, -75]

describe('anisotropic spot kernel', () => {
  // σ_total 0.06 × 0.02 mm at a 0.02/3 mm pitch: 9 × 3 cells.
  const pitch = 0.02 / 3
  const spot = (angleDeg: number): KernelSigma => ({ sigmaUMm: 0.06, sigmaVMm: 0.02, angleDeg })

  it.each(ANGLES)('conserves energy at %s°', (a) => {
    const { data, n } = impulse(spot(a), pitch)
    const m = moments(data, n)
    expect(Math.abs(m.sum - 1)).toBeLessThan(1e-5)
    // No drift: the response stays centred on the impulse.
    const c = (n - 1) / 2
    expect(Math.abs(m.mx - c)).toBeLessThan(1e-3)
    expect(Math.abs(m.my - c)).toBeLessThan(1e-3)
  })

  it.each(ANGLES)('rotates correctly at %s°: covariance and major axis match the rotated ellipse', (a) => {
    const k = spot(a)
    const { data, n } = impulse(k, pitch)
    const m = moments(data, n)
    const cov = covariance(k)
    const p2 = pitch * pitch
    // Truncation at 3σ trims ~2.7% of a Gaussian's variance; the rest is shape.
    const tol = 0.035 * cov.xx + 0.035 * cov.yy
    expect(Math.abs(m.xx * p2 - cov.xx)).toBeLessThan(tol)
    expect(Math.abs(m.yy * p2 - cov.yy)).toBeLessThan(tol)
    expect(Math.abs(m.xy * p2 - cov.xy)).toBeLessThan(tol)
    expect(Math.abs(axisDiff(m.angle, a))).toBeLessThan(0.5)
    // Principal sigmas: major/minor ratio within 3% of 3.
    const tr = m.xx + m.yy
    const det = m.xx * m.yy - m.xy * m.xy
    const l1 = tr / 2 + Math.sqrt((tr * tr) / 4 - det)
    const l2 = tr / 2 - Math.sqrt((tr * tr) / 4 - det)
    expect(rel(Math.sqrt(l1 / l2), 3)).toBeLessThan(0.03)
  })

  it('matches the sampled 2D Gaussian cell by cell within 2% of peak', () => {
    for (const a of [30, 45, 120]) {
      const k = spot(a)
      const { data, n } = impulse(k, pitch)
      const cov = covariance(k)
      const det = cov.xx * cov.yy - cov.xy * cov.xy
      const c = (n - 1) / 2
      const ref = new Float64Array(n * n)
      let sum = 0
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const dx = (x - c) * pitch
          const dy = (y - c) * pitch
          const q = (cov.yy * dx * dx - 2 * cov.xy * dx * dy + cov.xx * dy * dy) / det
          ref[y * n + x] = Math.exp(-q / 2)
          sum += ref[y * n + x]!
        }
      let peak = 0
      let worst = 0
      for (let i = 0; i < n * n; i++) peak = Math.max(peak, ref[i]! / sum)
      for (let i = 0; i < n * n; i++) worst = Math.max(worst, Math.abs(data[i]! - ref[i]! / sum))
      expect(worst / peak, `${a}°`).toBeLessThan(0.02)
    }
  })

  it('is symmetric: θ and θ + 180° give the same kernel, −θ mirrors θ in X', () => {
    const a = impulse(spot(30), pitch)
    const b = impulse(spot(210 - 360), pitch)
    const m = impulse(spot(-30), pitch)
    const { n } = a
    let d180 = 0
    let dMirror = 0
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        d180 = Math.max(d180, Math.abs(a.data[y * n + x]! - b.data[y * n + x]!))
        dMirror = Math.max(dMirror, Math.abs(a.data[y * n + x]! - m.data[y * n + (n - 1 - x)]!))
      }
    const peak = a.data.reduce((p, v) => Math.max(p, v), 0)
    expect(d180).toBeLessThan(1e-6 * peak)
    expect(dMirror / peak).toBeLessThan(1e-3)
  })

  it('axis-aligned spots keep the plain separable blur (no extra cost)', () => {
    for (const a of [0, 90, 180, -90]) expect(separableKernel(spot(a), pitch).skew).toBeNull()
    expect(separableKernel({ sigmaUMm: 0.03, sigmaVMm: 0.03, angleDeg: 37 }, pitch).skew).toBeNull()
    expect(separableKernel(spot(30), pitch).skew).not.toBeNull()
  })

  it('keeps the kernel footprint inside the tile margin', () => {
    for (const a of ANGLES) {
      const k = spot(a)
      const s = separableKernel(k, pitch)
      const margin = Math.ceil(kernelRadiusMm(k) / pitch)
      // Cells actually read: x + offset, and x + offset + 1 where it has weight.
      const skew = s.skew
      const shift = skew ? Math.max(...Array.from(skew.offset, (o, i) => Math.max(Math.abs(o), skew.w1[i]! > 0 ? Math.abs(o + 1) : 0))) : 0
      expect(s.x.radius + shift).toBeLessThanOrEqual(margin)
      expect(s.y.radius).toBeLessThanOrEqual(margin)
    }
  })
})

/** A straight M3 cut from (x0, y0) to (x1, y1), approached by a rapid. */
function lineJob(x0: number, y0: number, x1: number, y1: number, feed: number, s: number): JobModel {
  const moves: Move[] = [
    { kind: 'g0', xMm: x0, yMm: y0, feedMmPerMin: feed, s: 0, laser: 'off', line: 1 },
    { kind: 'g1', xMm: x1, yMm: y1, feedMmPerMin: feed, s, laser: 'm3', line: 2 },
  ]
  const burn = { minXMm: Math.min(x0, x1), minYMm: Math.min(y0, y1), maxXMm: Math.max(x0, x1), maxYMm: Math.max(y0, y1) }
  return {
    contractVersion: CONTRACT_VERSION,
    source: { kind: 'file', name: 'line', lineCount: 2 },
    startMm: { xMm: 0, yMm: 0 },
    moves,
    passes: [{ index: 0, firstMove: 0, moveCount: 2 }],
    bounds: { minXMm: 0, minYMm: 0, maxXMm: burn.maxXMm, maxYMm: burn.maxYMm },
    burnBounds: burn,
    diagnostics: [],
  }
}

/** Swap X and Y of every move: the same raster scanned along the other axis. */
function transpose(job: JobModel): JobModel {
  const b = job.burnBounds!
  return {
    ...job,
    moves: job.moves.map((m) => ({ ...m, xMm: m.yMm, yMm: m.xMm })),
    bounds: { minXMm: job.bounds.minYMm, minYMm: job.bounds.minXMm, maxXMm: job.bounds.maxYMm, maxYMm: job.bounds.maxXMm },
    burnBounds: { minXMm: b.minYMm, minYMm: b.minXMm, maxXMm: b.maxYMm, maxYMm: b.maxXMm },
  }
}

interface Burn {
  setup: SimSetup
  fluence: Float32Array
}

function burn(job: JobModel, m: MachineProfile, options: Parameters<typeof setupJob>[3] = {}): Burn {
  const setup = setupJob(job.burnBounds!, m, wood, options)
  return { setup, fluence: stitch(simulateCpu(storeFor(job, m), setup)).fluence.data }
}

/**
 * Fluence-weighted spread across a straight line (mm), from cells whose
 * projection along the line is within the middle half (cruise, no ends).
 */
function across(b: Burn, x0: number, y0: number, x1: number, y1: number): { sigmaMm: number; peak: number } {
  const { grid } = b.setup
  const len = Math.hypot(x1 - x0, y1 - y0)
  const ux = (x1 - x0) / len
  const uy = (y1 - y0) / len
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  let w = 0
  let m2 = 0
  let peak = 0
  for (let j = 0; j < grid.height; j++)
    for (let i = 0; i < grid.width; i++) {
      const px = grid.originXMm + (i + 0.5) * grid.pitchMm - cx
      const py = grid.originYMm + (j + 0.5) * grid.pitchMm - cy
      if (Math.abs(px * ux + py * uy) > len / 4) continue
      const v = b.fluence[j * grid.width + i]!
      const d = -px * uy + py * ux
      w += v
      m2 += v * d * d
      peak = Math.max(peak, v)
    }
  return { sigmaMm: Math.sqrt(m2 / w), peak }
}

/** σ_total across a line along unit direction (ux, uy): √(nᵀ Σ n). */
function expectedAcross(k: KernelSigma, ux: number, uy: number): number {
  const c = covariance(k)
  const nx = -uy
  const ny = ux
  return Math.sqrt(c.xx * nx * nx + 2 * c.xy * nx * ny + c.yy * ny * ny)
}

describe('raster direction', () => {
  const kernel = kernelSigma(machine.spot, wood.sigmaHeatMm)

  it('the provisional diode (long axis along Y) draws wider, lighter lines along X than along Y', () => {
    const alongX = across(burn(lineJob(0, 0.5, 1.5, 0.5, 1200, 300), machine), 0, 0.5, 1.5, 0.5)
    const alongY = across(burn(lineJob(0.5, 0, 0.5, 1.5, 1200, 300), machine), 0.5, 0, 0.5, 1.5)
    // Cross-line spread is the kernel's σ on the other axis (σ_total, heat included).
    expect(rel(alongX.sigmaMm, Math.hypot(machine.spot.sigmaXMm, wood.sigmaHeatMm))).toBeLessThan(0.04)
    expect(rel(alongY.sigmaMm, Math.hypot(machine.spot.sigmaYMm, wood.sigmaHeatMm))).toBeLessThan(0.04)
    // Same energy per length, so the narrow line is proportionally darker at its centre.
    expect(rel(alongY.peak / alongX.peak, alongX.sigmaMm / alongY.sigmaMm)).toBeLessThan(0.04)
    expect(alongY.peak).toBeGreaterThan(1.5 * alongX.peak)
  })

  it.each([0, 30, 45, 120, -60])('a spot at %s° makes line width depend on direction relative to the spot', (a) => {
    const m: MachineProfile = { ...machine, spot: { ...machine.spot, angleDeg: a } }
    const k = kernelSigma(m.spot, wood.sigmaHeatMm)
    const widths: number[] = []
    for (const dir of [a, a + 90, a + 60]) {
      const r = (dir * Math.PI) / 180
      const ux = Math.cos(r)
      const uy = Math.sin(r)
      // 1.2 mm line through (1, 1).
      const [x0, y0, x1, y1] = [1 - 0.6 * ux, 1 - 0.6 * uy, 1 + 0.6 * ux, 1 + 0.6 * uy]
      const got = across(burn(lineJob(x0, y0, x1, y1, 1200, 300), m), x0, y0, x1, y1)
      expect(rel(got.sigmaMm, expectedAcross(k, ux, uy)), `line at ${dir}°`).toBeLessThan(0.04)
      widths.push(got.sigmaMm)
    }
    // Along the long axis the line is narrowest; across it, widest.
    expect(widths[0]!).toBeLessThan(widths[2]!)
    expect(widths[2]!).toBeLessThan(widths[1]!)
  })

  it('striping: scan lines stacked along the short axis show much deeper ripple', () => {
    // Fill at 0.06 mm line interval; lines along X stack in Y (the long axis), lines along Y stack in X.
    const fill = rasterJob({ x0Mm: 0, y0Mm: 0, widthMm: 1.2, heightMm: 0.9, intervalMm: 0.06, feedMmPerMin: 1200, s: 300, laser: 'm3' })
    const ripple = (b: Burn, scanAlongX: boolean) => {
      const { grid } = b.setup
      // Cross-section through the middle of the fill, perpendicular to the scan lines, over its middle half.
      const lo = scanAlongX ? 0.225 : 0.3
      const hi = scanAlongX ? 0.675 : 0.9
      let min = Infinity
      let max = 0
      for (let i = 0; i < (scanAlongX ? grid.height : grid.width); i++) {
        const pos = (scanAlongX ? grid.originYMm : grid.originXMm) + (i + 0.5) * grid.pitchMm
        if (pos < lo || pos > hi) continue
        const at = scanAlongX ? 0.6 : 0.45
        const k = Math.floor((at - (scanAlongX ? grid.originXMm : grid.originYMm)) / grid.pitchMm)
        const v = scanAlongX ? b.fluence[i * grid.width + k]! : b.fluence[k * grid.width + i]!
        min = Math.min(min, v)
        max = Math.max(max, v)
      }
      return { ripple: (max - min) / ((max + min) / 2), mean: (max + min) / 2 }
    }
    const h = ripple(burn(fill, machine), true)
    const v = ripple(burn(transpose(fill), machine), false)
    // Sum of Gaussians spaced d: ripple ≈ 4·exp(−2π²σ²/d²); σ ≈ 0.033 vs 0.020 mm here.
    expect(h.ripple).toBeLessThan(0.05)
    expect(v.ripple).toBeGreaterThan(0.3)
    // Same energy per area either way.
    expect(rel(h.mean, v.mean)).toBeLessThan(0.15)
    expect(kernel.sigmaUMm).toBeGreaterThan(kernel.sigmaVMm)
  })
})

describe('rotated spot through the pipeline', () => {
  // Coarse spot keeps the CPU runs cheap: 0.08 × 0.04 mm at 30°.
  const m: MachineProfile = { ...machine, spot: { sigmaXMm: 0.08, sigmaYMm: 0.04, angleDeg: 30 } }
  const job = squareJob(1, 1, 2, 1200, 600)
  const store = storeFor(job, m)

  it('conserves energy at every stage', () => {
    const setup = setupJob(job.burnBounds!, m, wood)
    expect(setup.separable.skew).not.toBeNull()
    const { expectedJ, depositJ, blurHJ, blurVJ } = simulateCpu(store, setup).energy
    for (const v of [depositJ, blurHJ, blurVJ]) expect(rel(v, expectedJ)).toBeLessThan(CONSERVATION_TOLERANCE)
    expect(rel(blurVJ, depositJ)).toBeLessThan(1e-5)
  })

  it('tiled output matches untiled at the seams', () => {
    const untiled = setupJob(job.burnBounds!, m, wood)
    const tiled = setupJob(job.burnBounds!, m, wood, { maxTileCells: 160 })
    expect(tiled.plan.tiles.length).toBeGreaterThanOrEqual(4)
    const a = stitch(simulateCpu(store, untiled)).fluence.data
    const b = stitch(simulateCpu(store, tiled)).fluence.data
    let peak = 0
    let worst = 0
    for (let i = 0; i < a.length; i++) {
      peak = Math.max(peak, a[i]!)
      worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
    }
    expect(worst / peak).toBeLessThan(1e-5)
  })

  it('the hover readout matches the grid', () => {
    const setup = setupJob(job.burnBounds!, m, wood)
    const out = stitch(simulateCpu(store, setup))
    const reader = new CellReader(store, setup)
    for (const [x, y] of [
      [2, 1],
      [3, 3],
      [1.03, 2.5],
      [2.95, 1.05],
    ] as const) {
      const r = reader.readAt(x, y)!
      expect(rel(r.fluenceJPerMm2, out.fluence.data[r.cellY * setup.grid.width + r.cellX]!)).toBeLessThan(1e-4)
    }
  })
})

describe('S → optical power curve', () => {
  const lineAt = (s: number) => lineJob(0, 1, 10, 1, 3000, s)
  const energy = (s: number, mm = machine) => interimSampler.plan(lineAt(s), mm, 1).energyJ
  const full = energy(1000)

  it('the provisional diode curve has a threshold and a convex knee (provisional, COD-266)', () => {
    expect(machine.provenance.source).toBe('provisional')
    expect(interimSampler.plan(lineAt(40), machine, 1).sampleCount).toBe(0)
    expect(energy(50)).toBe(0)
    // Below the knee the slope is lower than linear: S 10% gives 4% power, S 20% gives 14%.
    expect(rel(energy(100) / full, 0.04)).toBeLessThan(1e-4)
    expect(rel(energy(200) / full, 0.14)).toBeLessThan(1e-4)
  })

  it('grayscale levels follow the curve, not S', () => {
    for (const s of [60, 75, 120, 150, 300, 500, 750]) expect(rel(energy(s) / full, interpolateCurve(machine.powerCurve, s / 1000))).toBeLessThan(1e-4)
    // A linear curve would give S/1000 instead.
    expect(energy(150) / full).toBeLessThan(0.15 * 0.7)
  })

  it('a calibrated curve in the profile replaces the default', () => {
    const fitted: MachineProfile = { ...machine, powerCurve: [{ s: 0, power: 0 }, { s: 0.02, power: 0 }, { s: 1, power: 1 }] }
    expect(energy(50, fitted)).toBeGreaterThan(0)
    expect(rel(energy(510, fitted) / energy(1000, fitted), 0.5)).toBeLessThan(1e-4)
  })
})

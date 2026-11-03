// SPDX-License-Identifier: MIT
// Thermal step (COD-258): the synthetic acceptance checks from the issue, run
// on the CPU reference. There is no laser yet, so these test the model's
// physics and bookkeeping; matching real burns is COD-254.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CONSERVATION_TOLERANCE,
  CONTRACT_VERSION,
  Verdict,
  checkMaterialProfile,
  decodeSampleBatch,
  flashKPerJPerMm2,
  flashSpeedFactor,
  flashTable,
  kernelSigma,
  type JobModel,
  type MachineProfile,
  type MaterialProfile,
  type Move,
  type PeakTemperatureModel,
} from '../contract/index.ts'
import {
  CellReader,
  CpuPeakTemperatureStep,
  SampleStore,
  depositCpu,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  simulateCoarseCpu,
  simulateCpu,
  stitch,
  thermalFor,
  type ThermalResult,
  type ThermalStep,
} from './index.ts'
import { concatJobs, rasterJob } from './test-jobs.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const diode = loadMachineProfile(provisional('machine-10w-diode.json'))
/** Linear S → power and fast acceleration, so equal-fluence pairs are exact and line centres cruise. */
const machine: MachineProfile = {
  ...diode,
  powerCurve: [
    { s: 0, power: 0 },
    { s: 1, power: 1 },
  ],
  accelMmPerS2: { x: 50_000, y: 50_000 },
}
const wood = loadMaterialProfile(provisional('birch-ply.json'))
const acrylic = loadMaterialProfile(provisional('black-cast-acrylic.json'))
const woodThermal = wood.thermal as PeakTemperatureModel

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30)

function storeFor(job: JobModel, m: MachineProfile = machine): SampleStore {
  const store = new SampleStore(1)
  for (const b of interimSampler.plan(job, m, 1).batches) store.append(decodeSampleBatch(b))
  return store
}

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

/** Readout at the middle of a single line burned at `feed` mm/min and S. */
function lineCentre(material: MaterialProfile, feed: number, s: number, alongY = false) {
  const job = alongY ? lineJob(1, 1, 1, 7, feed, s) : lineJob(1, 1, 7, 1, feed, s)
  const store = storeFor(job)
  return new CellReader(store, setupJob(job.burnBounds!, machine, material)).readAt(alongY ? 1 : 4, alongY ? 4 : 1)!
}

describe('thermal profiles', () => {
  it('wood and acrylic carry the COD-266 constants and pass the structural checks', () => {
    for (const m of [wood, acrylic]) {
      expect(m.thermal.kind).toBe('peakTemperature')
      expect(m.fireRisk.kind).toBe('temperature')
      expect(checkMaterialProfile(m)).toEqual([])
    }
    expect(woodThermal.conductivityWPerMmK / woodThermal.volumetricHeatCapacityJPerMm3K).toBeCloseTo(0.147, 2)
  })

  it('rejects inconsistent thermal blocks', () => {
    const t = woodThermal
    expect(checkMaterialProfile({ ...wood, thermal: { ...t, rampOnsetK: t.ambientK } })).toContain('thermal.rampOnsetK must be above thermal.ambientK')
    expect(checkMaterialProfile({ ...acrylic, thermal: { ...(acrylic.thermal as PeakTemperatureModel), absorptionAtFullChar: 0.9 } })).toContain(
      'thermal.absorptionAtFullChar applies to the char kind only',
    )
  })
})

describe('flash factor', () => {
  const kernel = kernelSigma(diode.spot, wood.sigmaHeatMm)
  const table = flashTable(diode.spot, kernel, woodThermal, 0.02)

  it('is 1 at the reference speed along X and grows with speed', () => {
    expect(flashSpeedFactor(table, woodThermal.referenceSpeedMmPerS, 0)).toBeCloseTo(1, 2)
    let last = 0
    for (const v of [2, 10, 50, 100, 200, 1000]) {
      const a = flashSpeedFactor(table, v, 0)
      expect(a).toBeGreaterThan(last)
      last = a
    }
    // Fast passes: conduction during the dwell is negligible, so the flash per fluence goes as √v.
    expect(rel(flashSpeedFactor(table, 1000, 0) / flashSpeedFactor(table, 250, 0), 2)).toBeLessThan(0.1)
  })

  it('is lower along the spot long axis (longer dwell) and symmetric under a half turn', () => {
    // The provisional diode's long axis is along Y.
    expect(flashSpeedFactor(table, 100, Math.PI / 2)).toBeLessThan(flashSpeedFactor(table, 100, 0))
    expect(flashSpeedFactor(table, 100, Math.PI)).toBeCloseTo(flashSpeedFactor(table, 100, 0), 6)
    expect(flashSpeedFactor(table, 100, -Math.PI / 2)).toBeCloseTo(flashSpeedFactor(table, 100, Math.PI / 2), 6)
  })
})

describe('equal-fluence pairs', () => {
  it('a cold pass at the reference speed along X has dose = fluence', () => {
    const r = lineCentre(wood, 6000, 400)
    expect(rel(r.doseJPerMm2!, r.fluenceJPerMm2)).toBeLessThan(0.02)
    expect(r.bulkTemperatureK).toBeLessThan(wood.thermal.kind === 'peakTemperature' ? woodThermal.ambientK + 1 : 0)
  })

  it.each([
    ['wood', wood],
    ['acrylic', acrylic],
  ])('%s: slower is cooler at the same fluence', (_name, material) => {
    // Halving speed and power keeps fluence; the slow pass loses more heat to conduction while it dwells.
    const pairs = [
      [8000, 800],
      [4000, 400],
      [2000, 200],
      [1000, 100],
    ] as const
    const reads = pairs.map(([feed, s]) => lineCentre(material, feed, s))
    for (let i = 1; i < reads.length; i++) {
      expect(rel(reads[i]!.fluenceJPerMm2, reads[0]!.fluenceJPerMm2)).toBeLessThan(0.01)
      expect(reads[i]!.peakTemperatureK!).toBeLessThan(reads[i - 1]!.peakTemperatureK!)
      expect(reads[i]!.doseJPerMm2!).toBeLessThan(reads[i - 1]!.doseJPerMm2!)
    }
    // Well separated: a 2× speed step moves dose by ≳ 25 %.
    expect(reads[1]!.doseJPerMm2! / reads[2]!.doseJPerMm2!).toBeGreaterThan(1.25)
  })

  it('lines along the spot long axis run cooler per unit fluence', () => {
    const x = lineCentre(wood, 6000, 400)
    const y = lineCentre(wood, 6000, 400, true)
    expect(y.doseJPerMm2! / y.fluenceJPerMm2).toBeLessThan(x.doseJPerMm2! / x.fluenceJPerMm2)
  })
})

describe('heat accumulation', () => {
  /**
   * Fill 1.5 mm tall at 0.1 mm interval; only its width changes. 5000 mm/s²
   * (a stiffer machine than the provisional diode) so short lines reach full
   * speed and the comparison isolates heat build-up. Line periods stay above
   * the 20 ms flash window, below which a neighbouring line's heat counts in
   * neither term.
   */
  const stiff: MachineProfile = { ...diode, accelMmPerS2: { x: 5000, y: 5000 } }
  const fill = (widthMm: number, s = 400) => {
    const job = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm, heightMm: 1.5, intervalMm: 0.1, feedMmPerMin: 6000, s })
    const store = storeFor(job, stiff)
    const setup = setupJob(job.burnBounds!, stiff, wood)
    // Centre of the fill's top half, where the most lines have passed nearby.
    return { store, setup, read: new CellReader(store, setup).readAt(1 + widthMm / 2, 2.2)! }
  }
  const small = fill(1.5)
  const large = fill(12)

  it('a small dense fill heats more than a large one at the same settings', () => {
    // Short lines come back sooner, so more of the previous lines' heat is still there.
    expect(rel(small.read.fluenceJPerMm2, large.read.fluenceJPerMm2)).toBeLessThan(0.05)
    expect(small.read.bulkTemperatureK!).toBeGreaterThan(large.read.bulkTemperatureK! + 100)
    expect(small.read.doseJPerMm2!).toBeGreaterThan(large.read.doseJPerMm2! * 1.1)
  })

  it('preheat raises dose above a cold pass, and the bulk temperature is physical (hundreds of K)', () => {
    const cold = lineCentre(wood, 6000, 400)
    expect(small.read.doseJPerMm2! / small.read.fluenceJPerMm2).toBeGreaterThan(cold.doseJPerMm2! / cold.fluenceJPerMm2)
    expect(small.read.bulkTemperatureK!).toBeGreaterThan(woodThermal.ambientK + 100)
    expect(small.read.bulkTemperatureK!).toBeLessThan(2000)
  })

  it('char raises absorption on a second pass over the same fill (absorption feedback)', () => {
    const once = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 1.5, heightMm: 1, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 })
    const job = concatJobs(once, once)
    const store = storeFor(job)
    const t = thermalFor(store, machine, wood, setupJob(job.burnBounds!, machine, wood).thermalKernel)!
    const absorbed = (from: number, to: number) => {
      let e = 0
      let a = 0
      for (let i = from; i < to; i++) {
        e += store.xye[i * 3 + 2]!
        a += t.eAbs[i]!
      }
      return a / e
    }
    const n = store.count
    const first = absorbed(0, Math.floor(n / 10))
    const second = absorbed(Math.floor(n / 2), n)
    expect(first).toBeCloseTo(wood.absorption, 2)
    expect(second).toBeGreaterThan(wood.absorption + 0.1)
    expect(second).toBeLessThanOrEqual(woodThermal.absorptionAtFullChar! + 1e-6)
  })

  it('fire risk is a bulk-temperature threshold: a hot small fill flags it, a normal one does not', () => {
    // The provisional diode as profiled (power curve, 1000 mm/s² accel).
    const fireCells = (widthMm: number, s: number) => {
      const job = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm, heightMm: 1.5, intervalMm: 0.1, feedMmPerMin: 6000, s })
      const out = stitch(simulateCpu(storeFor(job, diode), setupJob(job.burnBounds!, diode, wood)))
      return out.verdict.reduce((n, v) => n + (v === Verdict.FireRisk ? 1 : 0), 0)
    }
    expect(fireCells(1.5, 400)).toBe(0)
    expect(fireCells(1, 800)).toBeGreaterThan(0)
  })
})

describe('energy', () => {
  const job = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 2, heightMm: 1, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 })
  const store = storeFor(job)
  const setup = setupJob(job.burnBounds!, machine, wood)
  const run = new CpuPeakTemperatureStep().run(store, machine, wood, setup.thermalKernel)

  it('is conserved through the thermal grid: Σ ρc·ΔT·V = Σ absorbed energy injected', () => {
    let eAbs = 0
    for (let i = 0; i < run.count; i++) eAbs += run.eAbs[i]!
    expect(rel(run.grid.injectedJ, eAbs)).toBeLessThan(1e-9)
    expect(rel(run.grid.energyJ(), eAbs)).toBeLessThan(1e-4)
  })

  it('fluence and dose are conserved through deposit and blur', () => {
    const cpu = simulateCpu(store, setup)
    let eAbs = 0
    for (let i = 0; i < run.count; i++) eAbs += run.eAbs[i]!
    expect(rel(cpu.energy.expectedJ, eAbs)).toBeLessThan(1e-4)
    for (const k of ['depositJ', 'blurHJ', 'blurVJ'] as const) expect(rel(cpu.energy[k], eAbs)).toBeLessThan(CONSERVATION_TOLERANCE)
    let eDose = 0
    for (let i = 0; i < run.count; i++) eDose += run.eDose[i]!
    const whole = { x: 0, y: 0, width: setup.grid.width, height: setup.grid.height }
    const dep = depositCpu(store, store.count, setup.grid, whole, wood.absorption, run.eDose)
    expect(dep.clippedEnergyJ / eDose).toBeLessThan(1e-6)
    const out = stitch(cpu)
    const doseSum = out.dose!.reduce((s, v) => s + v, 0) * setup.grid.pitchMm ** 2
    expect(rel(doseSum, eDose)).toBeLessThan(CONSERVATION_TOLERANCE)
  })

  it('the coarse scrub deposits the same per-sample energies at every cutoff', () => {
    for (const frac of [0.3, 1]) {
      const cutoff = frac * store.sampledUntilS
      const n = store.countUntil(cutoff)
      let e = 0
      for (let i = 0; i < n; i++) e += run.eAbs[i]!
      const c = simulateCoarseCpu(store, setup, cutoff).energy
      expect(rel(c.expectedJ, e)).toBeLessThan(1e-4)
      expect(rel(c.blurVJ, e)).toBeLessThan(CONSERVATION_TOLERANCE)
    }
  })
})

describe('convergence', () => {
  // A small, dense fill: heat from neighbouring lines dominates the bulk term.
  const job = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 1.5, heightMm: 1, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 })
  const store = storeFor(job)
  const kernel = setupJob(job.burnBounds!, machine, wood).thermalKernel
  const level = (pitchMm: number, binS: number) => new CpuPeakTemperatureStep({ pitchMm, binS, nearS: 0.02 }).run(store, machine, wood, kernel)
  const levels = [level(0.2, 0.02), level(0.1, 0.01), level(0.05, 0.005)]
  const reference = level(0.025, 0.0025)

  /** Mean |Δ| of the per-sample bulk temperature and of the dose weight against b. */
  const diff = (a: (typeof levels)[number], b: (typeof levels)[number]) => {
    let dT = 0
    let dW = 0
    let meanT = 0
    for (let i = 0; i < a.count; i++) {
      dT += Math.abs(a.sampleBulkK[i]! - b.sampleBulkK[i]!)
      dW += Math.abs(a.eDose[i]! / a.eAbs[i]! - b.eDose[i]! / b.eAbs[i]!)
      meanT += b.sampleBulkK[i]!
    }
    return { dT: dT / a.count, dW: dW / a.count, meanT: meanT / a.count }
  }

  it('bulk temperature and dose weights converge as thermal pitch and time bins shrink', () => {
    // Against a 0.025 mm / 2.5 ms reference, at the same flash window (20 ms).
    const errors = levels.map((l) => diff(l, reference))
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!.dT).toBeLessThan(errors[i - 1]!.dT)
      expect(errors[i]!.dW).toBeLessThan(errors[i - 1]!.dW)
    }
    expect(errors[2]!.dT / errors[2]!.meanT).toBeLessThan(0.05)
  })
})

describe('the thermal step is swappable (Option A fallback seam)', () => {
  /** A stand-in empirical speed correction: dose = fluence · √(v / 100), no grid. */
  const speedCorrection: ThermalStep = {
    run(store, _machine, material): ThermalResult {
      const n = store.count
      const eAbs = new Float32Array(n)
      const eDose = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        eAbs[i] = store.xye[i * 3 + 2]! * material.absorption
        eDose[i] = eAbs[i]! * Math.sqrt(Math.max(store.speedMmPerS[i]!, 1) / 100)
      }
      const t = material.thermal as PeakTemperatureModel
      return { count: n, storeVersion: store.version, eAbs, eDose, bulkK: null, plan: null, ambientK: t.ambientK, flashK: flashKPerJPerMm2(material, t) }
    },
  }

  it('drives the same pipeline and readout from another step', () => {
    const job = lineJob(1, 1, 7, 1, 3000, 400)
    const store = storeFor(job)
    const setup = setupJob(job.burnBounds!, machine, wood, { thermalStep: speedCorrection })
    const r = new CellReader(store, setup).readAt(4, 1)!
    expect(rel(r.doseJPerMm2!, r.fluenceJPerMm2 * Math.SQRT1_2)).toBeLessThan(0.01)
    expect(r.bulkTemperatureK).toBe(woodThermal.ambientK)
    const out = stitch(simulateCpu(store, setup))
    expect(out.dose!.some((d) => d > 0)).toBe(true)
  })
})

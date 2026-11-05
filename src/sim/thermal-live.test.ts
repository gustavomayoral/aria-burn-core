// SPDX-License-Identifier: MIT
// BURN-35: the incremental thermal step for live jobs. A job streamed in
// chunks is continued over each new chunk (extend) instead of rerun; every
// result must equal a full run on the same store under the same live plan,
// and anything that breaks the continuation (a new plan, another material,
// a missing batch, job.loaded) must fall back to a full run.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  decodeSampleBatch,
  encodeSampleBatch,
  planLiveThermal,
  readSample,
  sameThermalPlan,
  type MachineProfile,
  type PeakTemperatureModel,
} from '../contract/index.ts'
import {
  CpuPeakTemperatureStep,
  LiveJob,
  SampleStore,
  interimSampler,
  lastThermalPath,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  thermalFor,
  type CpuThermalRun,
} from './index.ts'
import { concatJobs, rasterJob, squareJob } from './test-jobs.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const diode = loadMachineProfile(provisional('machine-10w-diode.json'))
const machine: MachineProfile = { ...diode, accelMmPerS2: { x: 50_000, y: 50_000 } }
const wood = loadMaterialProfile(provisional('birch-ply.json'))
const woodThermal = wood.thermal as PeakTemperatureModel

/** A raster that grows downward line by line, then a square around it that grows the bounds on every side. */
const job = concatJobs(
  rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 4, heightMm: 2.5, intervalMm: 0.1, feedMmPerMin: 4000, s: 350 }),
  squareJob(0.4, 0.4, 5.2, 900, 800, 'm3'),
)
/** The planner's batches cut into batches of `size` samples (same times), so a stream has many small batches. */
function rebatch(planned: ArrayBuffer[], size: number): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const buf of planned) {
    const b = decodeSampleBatch(buf)
    for (let i = 0; i < b.sampleCount; i += size) {
      const samples = []
      for (let j = i; j < Math.min(b.sampleCount, i + size); j++) samples.push(readSample(b, j))
      out.push(encodeSampleBatch({ sequence: out.length, t0S: b.t0S, jobId: b.jobId, last: false }, samples))
    }
  }
  return out
}
const planned = interimSampler.plan(job, machine, 1).batches
const sampleCount = planned.reduce((n, b) => n + decodeSampleBatch(b).sampleCount, 0)
const batches = rebatch(planned, Math.ceil(sampleCount / 96))
const kernel = setupJob(job.burnBounds!, machine, wood).thermalKernel

function maxDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length)
  let d = 0
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i]! - b[i]!))
  return d
}

/** Full run of the live plan on the same store, by a step that has never seen it. */
const fullRun = (store: SampleStore) => new CpuPeakTemperatureStep().run(store, machine, wood, kernel, 'live')

/** Feed `batches` in `chunks` near-equal chunks; after each, the step's result and how it got it. */
function stream(chunks: number, step = new CpuPeakTemperatureStep(), store = new SampleStore(1)) {
  const out: { result: CpuThermalRun; path: typeof lastThermalPath; store: SampleStore }[] = []
  let fed = 0
  for (let c = 1; c <= chunks; c++) {
    const upTo = Math.round((batches.length * c) / chunks)
    for (; fed < upTo; fed++) store.append(decodeSampleBatch(batches[fed]!))
    if (!store.count) continue
    const result = thermalFor(store, machine, wood, kernel, step, 'live') as CpuThermalRun
    out.push({ result, path: lastThermalPath, store })
  }
  return out
}

describe('live thermal plan (BURN-35)', () => {
  it('holds while the bounds grow inside a block and changes when they cross one', () => {
    const b = { minXMm: 10, minYMm: 10, maxXMm: 110, maxYMm: 20 }
    const p = planLiveThermal(b, 100, 100, woodThermal)
    // Span 102 mm → 16 mm blocks: 112 × 32 mm of grid, binS a power-of-two multiple of 10 ms.
    expect(p.grid.width * p.grid.pitchMm).toBeCloseTo(112, 0)
    expect(p.grid.height * p.grid.pitchMm).toBeCloseTo(32, 0)
    expect(Math.log2(p.binS / 0.01) % 1).toBe(0)
    expect(p.binCount).toBeLessThanOrEqual(1024)
    // Further down the same block, later in time (same binS octave): same plan.
    expect(sameThermalPlan(planLiveThermal({ ...b, maxYMm: 31 }, 150, 150, woodThermal), p)).toBe(true)
    // Past the block edge at y + margin = 32 mm, or past the next binS octave: a new plan.
    expect(sameThermalPlan(planLiveThermal({ ...b, maxYMm: 31.5 }, 150, 150, woodThermal), p)).toBe(false)
    expect(sameThermalPlan(planLiveThermal(b, 400, 400, woodThermal), p)).toBe(false)
  })
})

describe('incremental thermal step (BURN-35)', () => {
  const runs = stream(24)

  it('continues most chunks and reruns only when the live plan changed', () => {
    expect(batches.length).toBeGreaterThanOrEqual(24)
    const paths = runs.map((r) => r.path)
    expect(paths[0]).toBe('full')
    for (let i = 1; i < runs.length; i++) {
      const changed = !sameThermalPlan(runs[i]!.result.plan!, runs[i - 1]!.result.plan!)
      expect(paths[i]).toBe(changed ? 'full' : 'extended')
    }
    expect(paths.filter((p) => p === 'extended').length).toBeGreaterThan(paths.length / 2)
  })

  it('includes extended chunks that grew the bounds, and a full rerun where they crossed a block', () => {
    let grewExtended = 0
    const store = new SampleStore(1)
    const step = new CpuPeakTemperatureStep()
    let fed = 0
    let lastBounds: string | null = null
    let grewFull = 0
    for (let c = 1; c <= 24; c++) {
      for (; fed < Math.round((batches.length * c) / 24); fed++) store.append(decodeSampleBatch(batches[fed]!))
      if (!store.count) continue
      thermalFor(store, machine, wood, kernel, step, 'live')
      const bounds = JSON.stringify(store.burnBounds)
      if (lastBounds !== null && bounds !== lastBounds) {
        if (lastThermalPath === 'extended') grewExtended++
        else grewFull++
      }
      lastBounds = bounds
    }
    expect(grewExtended).toBeGreaterThan(0)
    expect(grewFull).toBeGreaterThan(0)
  })

  it('equals a full run of the same store after every chunk, sample for sample', () => {
    // The stream's store is shared and has grown to the end; replay chunk by chunk against fresh full runs.
    const store = new SampleStore(1)
    const step = new CpuPeakTemperatureStep()
    let fed = 0
    let extended = 0
    for (let c = 1; c <= 24; c++) {
      for (; fed < Math.round((batches.length * c) / 24); fed++) store.append(decodeSampleBatch(batches[fed]!))
      if (!store.count) continue
      const inc = thermalFor(store, machine, wood, kernel, step, 'live') as CpuThermalRun
      if (lastThermalPath === 'extended') extended++
      const full = fullRun(store)
      expect(sameThermalPlan(inc.plan!, full.plan!)).toBe(true)
      expect(inc.plan!.binCount).toBe(full.plan!.binCount)
      expect(maxDiff(inc.eAbs, full.eAbs)).toBe(0)
      expect(maxDiff(inc.eDose, full.eDose)).toBe(0)
      expect(maxDiff(inc.sampleBulkK, full.sampleBulkK)).toBe(0)
      expect(maxDiff(inc.bulkK!, full.bulkK!)).toBe(0)
      expect(inc.grid.injectedJ).toBe(full.grid.injectedJ)
      expect(maxDiff(inc.grid.state, full.grid.state)).toBe(0)
    }
    expect(extended).toBeGreaterThan(0)
    expect(runs.length).toBe(24)
  }, 30_000) // ~4 s alone (48 CPU runs); over 5 s in the full suite
})

describe('incremental thermal step falls back to a full run (BURN-35)', () => {
  const half = (store = new SampleStore(1)) => {
    for (let i = 0; i < batches.length / 2; i++) store.append(decodeSampleBatch(batches[i]!))
    return store
  }
  const more = (store: SampleStore, n = 1) => {
    const from = store.batchCount
    for (let i = from; i < from + n; i++) store.append(decodeSampleBatch(batches[i]!))
  }

  it('when the material or machine changes', () => {
    const step = new CpuPeakTemperatureStep()
    const store = half()
    thermalFor(store, machine, wood, kernel, step, 'live')
    more(store)
    thermalFor(store, machine, { ...wood }, kernel, step, 'live')
    expect(lastThermalPath).toBe('full')
    more(store)
    thermalFor(store, { ...machine }, wood, kernel, step, 'live')
    expect(lastThermalPath).toBe('full')
  })

  it('when a batch went missing (out of order)', () => {
    const step = new CpuPeakTemperatureStep()
    const store = half()
    thermalFor(store, machine, wood, kernel, step, 'live')
    // Skip one batch: the store records the gap.
    const skip = store.batchCount
    store.append(decodeSampleBatch(batches[skip + 1]!))
    expect(store.missingSequences.length).toBe(1)
    thermalFor(store, machine, wood, kernel, step, 'live')
    expect(lastThermalPath).toBe('full')
    // The gap stays; later chunks continue again.
    store.append(decodeSampleBatch(batches[skip + 2]!))
    thermalFor(store, machine, wood, kernel, step, 'live')
    expect(lastThermalPath).toBe('extended')
  })

  it('when job.loaded replaces live tiling (job plan)', () => {
    const live = new LiveJob(1, 'test', machine, wood)
    const step = new CpuPeakTemperatureStep()
    for (let i = 0; i < batches.length / 2; i++) live.onBatch(batches[i]!)
    const streaming = live.setup()!
    expect(streaming.thermalPlanning).toBe('live')
    thermalFor(live.store, machine, wood, streaming.thermalKernel, step, streaming.thermalPlanning)
    for (let i = Math.ceil(batches.length / 2); i < batches.length; i++) live.onBatch(batches[i]!)
    live.onEvent({ type: 'job.loaded', jobId: 1, job })
    const loaded = live.setup()!
    expect(loaded.thermalPlanning).toBeUndefined()
    const r = thermalFor(live.store, machine, wood, loaded.thermalKernel, step, loaded.thermalPlanning) as CpuThermalRun
    expect(lastThermalPath).toBe('full')
    expect(maxDiff(r.eDose, new CpuPeakTemperatureStep().run(live.store, machine, wood, kernel).eDose)).toBe(0)
  })
})

describe('a job-grid pitch step mid-stream leaves the live thermal plan alone (BURN-42)', () => {
  it('continues across k steps and still equals a full run, sample for sample', () => {
    const fine = setupJob(job.burnBounds!, machine, wood)
    const cellBudget = Math.ceil((fine.grid.width * fine.grid.height) / 6)
    const live = new LiveJob(1, 'live', machine, wood, { cellBudget })
    const step = new CpuPeakTemperatureStep()
    let prevPitch = 0
    let prevPlan: CpuThermalRun['plan'] | null = null
    let steppedExtended = 0
    let fed = 0
    for (let c = 1; c <= 24; c++) {
      for (; fed < Math.round((batches.length * c) / 24); fed++) live.onBatch(batches[fed]!)
      const setup = live.setup()
      if (!setup) continue
      // The thermal kernel is the full-resolution one at every k.
      expect(setup.thermalKernel).toEqual(kernel)
      const inc = thermalFor(live.store, machine, wood, setup.thermalKernel, step, setup.thermalPlanning) as CpuThermalRun
      const stepped = prevPitch > 0 && setup.grid.pitchMm > prevPitch
      if (prevPlan) expect(lastThermalPath).toBe(sameThermalPlan(inc.plan!, prevPlan) ? 'extended' : 'full')
      if (stepped && lastThermalPath === 'extended') steppedExtended++
      const full = fullRun(live.store)
      expect(maxDiff(inc.eAbs, full.eAbs)).toBe(0)
      expect(maxDiff(inc.eDose, full.eDose)).toBe(0)
      expect(maxDiff(inc.grid.state, full.grid.state)).toBe(0)
      prevPitch = setup.grid.pitchMm
      prevPlan = inc.plan!
    }
    expect(prevPitch / setupJob(job.burnBounds!, machine, wood, { cellBudget }).grid.pitchMm).toBe(1)
    expect(steppedExtended).toBeGreaterThan(0)
  }, 30_000)
})

// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  CONSERVATION_TOLERANCE,
  ChannelEvent,
  SAMPLE_DT_MAX_S,
  SAMPLE_FIELD_INDEX,
  SAMPLE_FIELD_COUNT,
  TILE_MAX_CELLS,
  GPU_BUDGET_BYTES,
  GPU_BUDGET_LARGE_BYTES,
  TILE_MIN_CELLS,
  Verdict,
  defaultGpuBudgetBytes,
  buildContractSchema,
  classifyFluence,
  classifyThermal,
  decodeSampleBatch,
  gridPitchMm,
  planJobGrid,
  planLiveTiles,
  tilePoolBytes,
  tileSideForBytes,
  validate,
  type JobModel,
  type MachineProfile,
  type MaterialProfile,
} from '../contract/index.ts'
import {
  CellReader,
  GlAllocationError,
  LiveJob,
  SampleBins,
  SampleStore,
  blurCpu,
  cellDepthMm,
  cellLab,
  depositCpu,
  interimSampler,
  kernel1D,
  labToSrgb8,
  loadMachineProfile,
  loadMaterialProfile,
  planSide,
  replan,
  responseParams,
  setupJob,
  simulateCoarseCpu,
  simulateCpu,
  stitch,
  tileSide,
  watchContextLoss,
  withTileFallback,
  type SimSetup,
} from './index.ts'
import { concatJobs, rasterJob, squareJob } from './test-jobs.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
const wood = loadMaterialProfile(provisional('birch-ply.json'))
const acrylic = loadMaterialProfile(provisional('black-cast-acrylic.json'))
const anodized = loadMaterialProfile(provisional('black-anodized-aluminum.json'))
/** Wood without the thermal step (COD-258), for tests of the fluence stages on jobs too big for a quick CPU thermal run. */
const woodFluence: MaterialProfile = { ...wood, thermal: { kind: 'none' }, fireRisk: { kind: 'none' } }

/** Round spot at the COD-251 spike's σ = 0.05 mm: coarser pitch, cheap CPU runs. */
const roundSpot: MachineProfile = { ...machine, spot: { sigmaXMm: 0.05, sigmaYMm: 0.05, angleDeg: 0 } }

function storeFor(job: JobModel, m: MachineProfile = machine, jobId = 1): { store: SampleStore; plan: ReturnType<typeof interimSampler.plan> } {
  const plan = interimSampler.plan(job, m, jobId)
  const store = new SampleStore(jobId)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  return { store, plan }
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30)

describe('profiles load from data files and are validated', () => {
  it('loads the provisional profiles', () => {
    expect(wood.response.kind).toBe('char')
    expect(acrylic.response.kind).toBe('melt')
    expect(anodized.response.kind).toBe('bleach')
  })

  it('rejects schema violations and ordering problems', () => {
    const bad = JSON.parse(provisional('birch-ply.json')) as MaterialProfile
    expect(() => loadMaterialProfile({ ...bad, extra: 1 })).toThrow(/invalid/)
    expect(() => loadMaterialProfile({ ...bad, absorption: 2 })).toThrow(/absorption/)
    const flipped = { ...bad, response: { ...bad.response, toneStartJPerMm2: 5 } }
    expect(() => loadMaterialProfile(flipped)).toThrow(/toneStart/)
    expect(() => loadMachineProfile('{"contractVersion":1}')).toThrow(/invalid/)
  })
})

describe('interim sampler', () => {
  const line = (laser: 'm3' | 'm4', lengthMm = 20, feed = 3000) =>
    ({
      ...squareJob(0, 0, 1, feed, 1000),
      moves: [
        // Rapid straight up, then the cut along +X: a 90° junction, so the cut starts from rest.
        { kind: 'g0', xMm: 0, yMm: 5, feedMmPerMin: feed, s: 0, laser: 'off', line: 1 },
        { kind: 'g1', xMm: lengthMm, yMm: 5, feedMmPerMin: feed, s: 1000, laser, line: 2 },
      ],
      burnBounds: { minXMm: 0, minYMm: 5, maxXMm: lengthMm, maxYMm: 5 },
    }) as JobModel

  it('emits contiguous batches in the contract layout with the last flag at the end', () => {
    const { plan } = storeFor(rasterJob({ x0Mm: 0, y0Mm: 0, widthMm: 10, heightMm: 1, intervalMm: 0.1, feedMmPerMin: 6000, s: 500 }))
    const views = plan.batches.map((b) => decodeSampleBatch(b))
    expect(views.map((v) => v.sequence)).toEqual(views.map((_, i) => i))
    expect(views.map((v) => v.last)).toEqual(views.map((_, i) => i === views.length - 1))
    expect(views.reduce((n, v) => n + v.sampleCount, 0)).toBe(plan.sampleCount)
  })

  it('obeys the sampling rule: dt ≤ SAMPLE_DT_MAX_S, steps ≈ gridPitchMm, time non-decreasing', () => {
    const { store, plan } = storeFor(line('m3'))
    const batch = decodeSampleBatch(plan.batches[0]!)
    const pitch = gridPitchMm(machine.spot)
    let prevT = -1
    let path = 0
    for (let i = 0; i < batch.sampleCount; i++) {
      const o = i * SAMPLE_FIELD_COUNT
      const dt = batch.f32[o + SAMPLE_FIELD_INDEX.dtS]!
      const v = batch.f32[o + SAMPLE_FIELD_INDEX.speedMmPerS]!
      expect(dt).toBeLessThanOrEqual(SAMPLE_DT_MAX_S * (1 + 1e-6))
      // Equal-time intervals: under acceleration one interval can reach 2× the block's mean step.
      expect(v * dt).toBeLessThanOrEqual(2 * pitch)
      expect(store.tS[i]!).toBeGreaterThanOrEqual(prevT)
      prevT = store.tS[i]!
      path += v * dt
    }
    // Midpoint speed × dt is each interval's exact length under constant acceleration.
    expect(rel(path, 20)).toBeLessThan(1e-4)
    expect(batch.sampleCount).toBeGreaterThanOrEqual(20 / pitch)
  })

  it('M3 deposits constant power over the beam-on time; the trapezoid timing is exact', () => {
    const { plan } = storeFor(line('m3'))
    const v = 3000 / 60
    const a = machine.accelMmPerS2.x
    // 20 mm from rest to rest at 50 mm/s, 1000 mm/s²: 2 × v/a accelerating plus cruise.
    const beamOnS = 2 * (v / a) + (20 - (v * v) / a) / v
    const power = machine.opticalPowerW
    expect(rel(plan.energyJ, power * beamOnS)).toBeLessThan(1e-5)
    // Plus the g0 rapid from the origin, beam off.
    expect(plan.durationS).toBeGreaterThan(beamOnS)
  })

  it('M4 scales power with actual speed, so it deposits less during acceleration', () => {
    // Linear S → power curve, so M4 power is exactly ∝ speed (the provisional curve has a dead zone).
    const linear: MachineProfile = { ...machine, powerCurve: [{ s: 0, power: 0 }, { s: 1, power: 1 }] }
    const m3 = storeFor(line('m3'), linear).plan
    const m4 = storeFor(line('m4'), linear).plan
    const v = 50
    const a = machine.accelMmPerS2.x
    // Ramps carry ½ the M3 energy under M4 (power ∝ v, v linear in t).
    const rampS = 2 * (v / a)
    expect(rel(m3.energyJ - m4.energyJ, 0.5 * machine.opticalPowerW * rampS)).toBeLessThan(1e-4)
  })

  it('stops at sharp corners and keeps speed through collinear segments', () => {
    const split: JobModel = {
      ...line('m3'),
      moves: [
        { kind: 'g0', xMm: 0, yMm: 5, feedMmPerMin: 3000, s: 0, laser: 'off', line: 1 },
        { kind: 'g1', xMm: 10, yMm: 5, feedMmPerMin: 3000, s: 1000, laser: 'm3', line: 2 },
        { kind: 'g1', xMm: 20, yMm: 5, feedMmPerMin: 3000, s: 1000, laser: 'm3', line: 3 },
      ],
    }
    // Two collinear halves: same energy as one 20 mm move.
    expect(rel(storeFor(split).plan.energyJ, storeFor(line('m3')).plan.energyJ)).toBeLessThan(1e-5)
    // Square: four 90° corners, each a full stop; minimum speed near each corner ≈ 0.
    const { plan } = storeFor(squareJob(5, 5, 10, 3000, 1000, 'm3'))
    const b = decodeSampleBatch(plan.batches[0]!)
    let slow = 0
    for (let i = 0; i < b.sampleCount; i++) if (b.f32[i * SAMPLE_FIELD_COUNT + SAMPLE_FIELD_INDEX.speedMmPerS]! < 2) slow++
    expect(slow).toBeGreaterThanOrEqual(8)
  })

  it('beam-off moves advance the clock without samples', () => {
    const { store } = storeFor(line('m3'))
    // First sample comes after the g0 rapid to (0, 5).
    expect(store.tS[0]!).toBeGreaterThan(0.01)
    expect(store.burnBounds!.minYMm).toBeCloseTo(5, 5)
  })
})

describe('deposit and blur conserve fluence', () => {
  const job = squareJob(2, 2, 3, 1200, 600)
  const { store } = storeFor(job)
  const setup = setupJob(job.burnBounds!, machine, wood)

  it('bilinear deposit matches Σ power·dt·absorption with nothing clipped', () => {
    const whole = { x: 0, y: 0, width: setup.grid.width, height: setup.grid.height }
    const dep = depositCpu(store, store.count, setup.grid, whole, wood.absorption)
    const sum = dep.data.reduce((s, v) => s + v, 0) * setup.grid.pitchMm ** 2
    expect(dep.clippedEnergyJ).toBeLessThan(1e-12)
    expect(rel(sum, store.energyJ * wood.absorption)).toBeLessThan(1e-4)
    const { afterH, afterV } = blurCpu(dep.data, whole.width, whole.height, setup.separable)
    for (const stage of [afterH, afterV])
      expect(rel(stage.reduce((s, v) => s + v, 0) * setup.grid.pitchMm ** 2, sum)).toBeLessThan(CONSERVATION_TOLERANCE)
  })

  it('discrete kernels are normalised and sized by σ_total = √(σ_spot² + σ_heat²)', () => {
    const k = kernel1D(3)
    expect(k.radius).toBe(9)
    expect(k.weights.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6)
    const pitch = setup.grid.pitchMm
    expect(setup.separable.y.sigmaCells * pitch).toBeCloseTo(Math.hypot(machine.spot.sigmaXMm, wood.sigmaHeatMm), 9)
    expect(setup.separable.x.sigmaCells * pitch).toBeCloseTo(Math.hypot(machine.spot.sigmaYMm, wood.sigmaHeatMm), 9)
    expect(setup.separable.skew).toBeNull()
  })

  it('per-stage energy of a full run is within 1%', () => {
    const run = simulateCpu(store, setup)
    const { expectedJ, depositJ, blurHJ, blurVJ } = run.energy
    for (const v of [depositJ, blurHJ, blurVJ]) expect(rel(v, expectedJ)).toBeLessThan(CONSERVATION_TOLERANCE)
  })
})

describe('response kinds', () => {
  it('char: tone ramp, then ablation depth above its threshold', () => {
    const p = responseParams(wood)
    expect(cellLab(p, 0, false)).toEqual(wood.response.kind === 'char' && wood.response.baseColor)
    expect(cellLab(p, 100, false).l).toBeCloseTo(28)
    expect(cellDepthMm(p, 0.4)).toBe(0)
    expect(cellDepthMm(p, 1.43)).toBeCloseTo(0.17)
  })

  it('melt: frost ramp, removal depth, polished edge next to removed cells', () => {
    const p = responseParams(acrylic)
    expect(cellLab(p, 0.29, false).l).toBeCloseTo(50)
    expect(cellLab(p, 1, true).l).toBeCloseTo(8)
    expect(cellDepthMm(p, 2.9)).toBeCloseTo(0.3)
  })

  it('bleach: mark ramp, never any depth', () => {
    const p = responseParams(anodized)
    expect(cellLab(p, 1.695, false).l).toBeCloseTo((20 + 82) / 2)
    expect(cellDepthMm(p, 100)).toBe(0)
  })

  it('Lab → sRGB matches reference points', () => {
    expect(labToSrgb8({ l: 100, a: 0, b: 0 })).toEqual([255, 255, 255])
    expect(labToSrgb8({ l: 0, a: 0, b: 0 })).toEqual([0, 0, 0])
    expect(labToSrgb8({ l: 53.24, a: 80.09, b: 67.2 })).toEqual([255, 0, 0])
  })

  it('per-cell verdict and polished-edge colour come out of a real run', () => {
    // Slow, high-power line on acrylic: removed centre, polished edge, frosted shoulder.
    const job = squareJob(1, 1, 1.5, 300, 1000)
    const { store } = storeFor(job)
    const setup = setupJob(job.burnBounds!, machine, acrylic)
    const out = stitch(simulateCpu(store, setup))
    const counts = new Map<number, number>()
    // The acrylic profile has a thermal model: the verdict reads dose and bulk temperature.
    for (let i = 0; i < out.verdict.length; i++) {
      expect(out.verdict[i]).toBe(classifyThermal(acrylic, out.dose![i]!, out.bulkTemperatureK![i]!))
      counts.set(out.verdict[i]!, (counts.get(out.verdict[i]!) ?? 0) + 1)
    }
    expect(counts.get(Verdict.Over)).toBeGreaterThan(0)
    expect(counts.get(Verdict.InRange)).toBeGreaterThan(0)
    expect(out.depthMm.some((d) => d > 0)).toBe(true)
  })
})

/** Compare two stitched runs cell by cell. */
function compareRuns(a: SimSetup, outA: ReturnType<typeof stitch>, outB: ReturnType<typeof stitch>) {
  let maxF = 0
  let peak = 0
  let colorDelta = 0
  let verdictDiff = 0
  for (let i = 0; i < outA.fluence.data.length; i++) {
    maxF = Math.max(maxF, Math.abs(outA.fluence.data[i]! - outB.fluence.data[i]!))
    peak = Math.max(peak, outA.fluence.data[i]!)
    if (outA.verdict[i] !== outB.verdict[i]) verdictDiff++
  }
  for (let i = 0; i < outA.color.length; i++) colorDelta = Math.max(colorDelta, Math.abs(outA.color[i]! - outB.color[i]!))
  return { maxRelF: maxF / peak, colorDelta, verdictDiff, cells: a.grid.width * a.grid.height }
}

describe('tiling', () => {
  // A raster that straddles several small tiles, on the round spot to keep the CPU run quick.
  const job = concatJobs(
    rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 8, heightMm: 3, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 }),
    squareJob(2, 4.5, 3, 900, 700),
  )
  const { store } = storeFor(job, roundSpot)

  it('tiled output matches untiled at the seams', () => {
    const untiled = setupJob(job.burnBounds!, roundSpot, wood)
    const tiled = setupJob(job.burnBounds!, roundSpot, wood, { maxTileCells: 160 })
    expect(untiled.plan.tiles).toHaveLength(1)
    expect(tiled.plan.tiles.length).toBeGreaterThanOrEqual(6)
    const a = stitch(simulateCpu(store, untiled))
    const b = stitch(simulateCpu(store, tiled))
    const d = compareRuns(untiled, a, b)
    expect(d.maxRelF).toBeLessThan(1e-5)
    expect(d.colorDelta).toBeLessThanOrEqual(1)
    expect(d.verdictDiff / d.cells).toBeLessThan(1e-4)
  })

  it('live lattice tiles also match untiled, stay within budget and never move as the grid grows', () => {
    const untiled = setupJob(job.burnBounds!, roundSpot, wood)
    const live = setupJob(job.burnBounds!, roundSpot, wood, { maxTileCells: 160, tiling: 'live' })
    const d = compareRuns(untiled, stitch(simulateCpu(store, untiled)), stitch(simulateCpu(store, live)))
    expect(d.maxRelF).toBeLessThan(1e-5)
    expect(d.colorDelta).toBeLessThanOrEqual(1)

    const pitch = untiled.grid.pitchMm
    const small = planJobGrid({ minXMm: 1, minYMm: 1, maxXMm: 3, maxYMm: 2 }, pitch, untiled.kernel)
    const big = planJobGrid({ minXMm: -4, minYMm: 1, maxXMm: 9, maxYMm: 7 }, pitch, untiled.kernel)
    const abs = (g: typeof small, t: { col: number; row: number; core: { x: number; y: number } }) => ({
      col: t.col,
      row: t.row,
      // Absolute lattice cell of the core's first cell, when the core starts on a lattice boundary.
      x: Math.round(g.originXMm / pitch) + t.core.x,
      y: Math.round(g.originYMm / pitch) + t.core.y,
    })
    const a = planLiveTiles(small, untiled.kernel, 160)
    const b = planLiveTiles(big, untiled.kernel, 160)
    let covered = 0
    for (const t of b.tiles) {
      expect(t.padded.width).toBeLessThanOrEqual(160)
      expect(t.padded.height).toBeLessThanOrEqual(160)
      covered += t.core.width * t.core.height
    }
    expect(covered).toBe(big.width * big.height)
    const core = 160 - 2 * a.marginCells
    for (const t of a.tiles) {
      const match = b.tiles.find((u) => u.col === t.col && u.row === t.row)!
      expect(match).toBeDefined()
      // Same lattice cell range start (interior tiles begin at col·core).
      const pa = abs(small, t)
      const pb = abs(big, match)
      if (pa.x % core === 0) expect(pb.x).toBe(pa.x)
      if (pa.y % core === 0) expect(pb.y).toBe(pa.y)
    }
  })

  it('without a GPU budget the plan only obeys the 9000-cell hard cap', () => {
    const big = setupJob({ minXMm: 0, minYMm: 0, maxXMm: 100, maxYMm: 100 }, machine, wood)
    expect(big.plan.tiles.length).toBeGreaterThan(1)
    for (const t of big.plan.tiles) expect(Math.max(t.padded.width, t.padded.height)).toBeLessThanOrEqual(TILE_MAX_CELLS)
  })
})

describe('tile budget by GPU bytes (BURN-36)', () => {
  const job = concatJobs(
    rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 8, heightMm: 3, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 }),
    squareJob(2, 4.5, 3, 900, 700),
  )
  const { store } = storeFor(job, roundSpot)
  const isAlloc = (e: unknown) => e instanceof GlAllocationError

  it('derives the tile side from bytes: 17 bytes a cell, capped at 9000', () => {
    expect(tilePoolBytes(1, 1)).toBe(17)
    // Iris Xe (BURN-33): a 6711² padded tile is a ~767 MB pool.
    expect(tileSideForBytes(tilePoolBytes(6711, 6711))).toBe(6711)
    expect(tilePoolBytes(tileSideForBytes(767e6) + 1, tileSideForBytes(767e6) + 1)).toBeGreaterThan(767e6)
    expect(tileSideForBytes(1e12)).toBe(TILE_MAX_CELLS)
    expect(tileSideForBytes(-5)).toBe(0)
  })

  it('picks the conservative budget for integrated Intel GPUs', () => {
    expect(defaultGpuBudgetBytes('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(GPU_BUDGET_BYTES)
    expect(defaultGpuBudgetBytes('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)')).toBe(GPU_BUDGET_LARGE_BYTES)
    expect(GPU_BUDGET_LARGE_BYTES).toBeGreaterThan(GPU_BUDGET_BYTES)
  })

  it('subtracts what else is resident, within the device cap and never below the minimum', () => {
    const budget = tilePoolBytes(6000, 6000)
    expect(tileSide({ budgetBytes: budget, otherBytes: 0 })).toBe(6000)
    // A 4096² overview with mips (~464 MB) leaves a much smaller tile.
    expect(tileSide({ budgetBytes: budget, otherBytes: 464e6 })).toBeLessThan(4000)
    expect(tileSide({ budgetBytes: budget, otherBytes: 0, maxSide: 3000 })).toBe(3000)
    // A learned or device cap wins over the minimum.
    expect(tileSide({ budgetBytes: budget, otherBytes: budget * 2, maxSide: 800 })).toBe(800)
    expect(tileSide({ budgetBytes: budget, otherBytes: budget * 2 })).toBe(TILE_MIN_CELLS)
  })

  it('a forced allocation failure falls back to smaller tiles that still match untiled', () => {
    const untiled = setupJob(job.burnBounds!, roundSpot, wood)
    const start = planSide(untiled.plan)
    // The "GPU" refuses any pool bigger than 160².
    const limit = tilePoolBytes(160, 160)
    const sides: number[] = []
    const run = withTileFallback(
      start,
      (side) => {
        sides.push(side)
        const plan = replan(untiled, side)
        const p = planSide(plan)
        if (tilePoolBytes(p, p) > limit) throw new GlAllocationError(`refused ${p}²`, tilePoolBytes(p, p))
        return { plan, tiles: simulateCpu(store, { ...untiled, plan }) }
      },
      isAlloc,
      64,
    )
    expect(run.failed.length).toBeGreaterThan(0)
    expect(run.failed[0]).toBe(start)
    expect(sides).toEqual([...run.failed, run.side])
    expect(planSide(run.result.plan)).toBeLessThanOrEqual(160)
    expect(run.result.plan.tiles.length).toBeGreaterThan(1)
    const d = compareRuns(untiled, stitch(simulateCpu(store, untiled)), stitch(run.result.tiles))
    expect(d.maxRelF).toBeLessThan(1e-5)
    expect(d.colorDelta).toBeLessThanOrEqual(1)
  })

  it('gives up below the minimum side, and other errors are not retried', () => {
    let calls = 0
    const refuse = () => {
      calls++
      throw new GlAllocationError('refused')
    }
    expect(() => withTileFallback(1024, refuse, isAlloc, 512)).toThrow(GlAllocationError)
    expect(calls).toBe(2) // 1024, then 724; 512 would be next but 724·√½ < 512
    calls = 0
    expect(() =>
      withTileFallback(
        1024,
        () => {
          calls++
          throw new Error('shader compile')
        },
        isAlloc,
      ),
    ).toThrow('shader compile')
    expect(calls).toBe(1)
  })

  it('live tiling respects the same budget and keeps its lattice when replanned', () => {
    const live = new LiveJob(1, 'budget', roundSpot, wood)
    const { plan } = storeFor(job, roundSpot)
    for (const b of plan.batches) live.onBatch(b)
    const setup = live.setup(160)!
    expect(setup.tiling).toBe('live')
    expect(planSide(setup.plan)).toBeLessThanOrEqual(160)
    // A smaller side from a failed allocation rebuilds the lattice, not a regular split.
    const smaller = replan(setup, 120)
    const lattice = planLiveTiles(setup.grid, setup.kernel, 120)
    expect(smaller.tiles.map((t) => t.core)).toEqual(lattice.tiles.map((t) => t.core))
    expect(planSide(smaller)).toBeLessThanOrEqual(120)
    // Live grids come from the samples' bounds, so compare against an untiled run on the same grid.
    const untiled = setupJob(live.store.burnBounds!, roundSpot, wood)
    expect(untiled.grid).toEqual(setup.grid)
    const d = compareRuns(untiled, stitch(simulateCpu(live.store, untiled)), stitch(simulateCpu(live.store, { ...setup, plan: smaller })))
    expect(d.maxRelF).toBeLessThan(1e-5)
  })
})

describe('WebGL context loss (BURN-36)', () => {
  it('prevents the default so the context comes back, and reports loss and restore', () => {
    const canvas = new EventTarget()
    const seen: string[] = []
    const watch = watchContextLoss(canvas, { onLost: () => seen.push('lost'), onRestored: () => seen.push('restored') })
    expect(watch.state).toBe('ok')
    const lost = new Event('webglcontextlost', { cancelable: true })
    canvas.dispatchEvent(lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(watch.state).toBe('lost')
    canvas.dispatchEvent(new Event('webglcontextrestored'))
    expect(watch.state).toBe('restored')
    expect(watch.losses).toBe(1)
    watch.stop()
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
    expect(seen).toEqual(['lost', 'restored'])
  })
})

describe('spatial bins', () => {
  const job = rasterJob({ x0Mm: 0, y0Mm: 0, widthMm: 10, heightMm: 6, intervalMm: 0.2, feedMmPerMin: 6000, s: 400 })
  const { store, plan } = storeFor(job, roundSpot)
  const bins = new SampleBins(store, 0.7)

  it('ranges hold exactly the samples inside the rect up to the cutoff, plus bucket slack', () => {
    const cutoff = plan.durationS * 0.4
    const [x0, y0, x1, y1] = [2.1, 1.3, 6.4, 4.2]
    const inRanges = new Set<string>()
    let total = 0
    for (const [first, count] of bins.ranges(x0, y0, x1, y1, cutoff))
      for (let i = first; i < first + count; i++) {
        expect(bins.tS[i]!).toBeLessThanOrEqual(cutoff)
        inRanges.add(`${bins.xye[i * 3]},${bins.xye[i * 3 + 1]},${bins.tS[i]}`)
        total++
      }
    expect(inRanges.size).toBe(total)
    let inside = 0
    for (let s = 0; s < store.count; s++) {
      const x = store.xye[s * 3]!
      const y = store.xye[s * 3 + 1]!
      if (x < x0 || x > x1 || y < y0 || y > y1 || store.tS[s]! > cutoff) continue
      inside++
      expect(inRanges.has(`${x},${y},${store.tS[s]}`)).toBe(true)
    }
    expect(total).toBeGreaterThanOrEqual(inside)
    expect(total).toBeLessThan(store.countUntil(cutoff))
  })
})

describe('progressive scrub', () => {
  const job = rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 20, heightMm: 10, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 })
  const { store, plan } = storeFor(job, roundSpot)
  const full = setupJob(job.burnBounds!, roundSpot, woodFluence)

  it('coarse conserves fluence against full-res within 1% at every stage and cutoff', () => {
    for (const frac of [0.25, 0.6, 1]) {
      const cutoff = frac * plan.durationS
      const f = simulateCpu(store, full, { timeCutoffS: cutoff }).energy
      const c = simulateCoarseCpu(store, full, cutoff).energy
      expect(rel(c.expectedJ, f.expectedJ)).toBeLessThan(1e-9)
      for (const k of ['depositJ', 'blurHJ', 'blurVJ'] as const) expect(rel(c[k], f.blurVJ)).toBeLessThan(CONSERVATION_TOLERANCE)
    }
  })

  it('the coarse kernel is widened to at least one coarse cell', () => {
    const c = simulateCoarseCpu(store, full, plan.durationS)
    const k = c.setup.separable
    expect(Math.min(k.x.sigmaCells, k.y.sigmaCells)).toBeGreaterThanOrEqual(1 - 1e-9)
  })

  it('the cutoff only deposits samples at or before it', () => {
    const half = plan.durationS / 2
    const n = store.countUntil(half)
    expect(store.tS[n - 1]!).toBeLessThanOrEqual(half)
    expect(store.tS[n]!).toBeGreaterThan(half)
  })
})

describe('hover readout', () => {
  const job = squareJob(1, 1, 2, 1200, 800)
  const { store } = storeFor(job)
  const setup = setupJob(job.burnBounds!, machine, wood)
  const out = stitch(simulateCpu(store, setup))
  const reader = new CellReader(store, setup)

  it('matches the grid pipeline per cell and names the contributing lines', () => {
    // Sample a few cells along the bottom edge (line 2) and a corner (lines 2 and 5).
    const w = setup.grid.width
    let checked = 0
    for (const [xMm, yMm] of [
      [2, 1],
      [2.5, 1.01],
      [1, 1],
      [3, 2],
    ] as const) {
      const r = reader.readAt(xMm, yMm)!
      const grid = out.fluence.data[r.cellY * w + r.cellX]!
      expect(rel(r.fluenceJPerMm2, grid)).toBeLessThan(1e-4)
      expect(r.verdict).toBe(out.verdict[r.cellY * w + r.cellX])
      expect(r.depthMm).toBeCloseTo(out.depthMm[r.cellY * w + r.cellX]!, 6)
      checked++
    }
    expect(checked).toBe(4)
    expect(reader.readAt(2, 1)!.lines[0]).toBe(2)
    expect(reader.readAt(1, 1)!.lines.slice(0, 2).sort()).toEqual([2, 5])
    expect(reader.readAt(-50, -50)).toBeNull()
  })

  it('respects the scrub cutoff', () => {
    const r = reader.readAt(1, 2, 0)!
    expect(r.fluenceJPerMm2).toBe(0)
    expect(r.verdict).toBe(Verdict.Untouched)
  })
})

describe('live (network) jobs', () => {
  const job = rasterJob({ x0Mm: 0, y0Mm: 0, widthMm: 12, heightMm: 4, intervalMm: 0.1, feedMmPerMin: 6000, s: 400 })
  const plan = interimSampler.plan(job, roundSpot, 7)

  it('grows stats, grid and lattice tiles as batches arrive and follows the head', () => {
    const live = new LiveJob(7, 'lightburn-job', roundSpot, wood, { maxTileCells: 160 })
    live.onEvent({ type: 'job.streaming', jobId: 7, name: 'lightburn-job' })
    const half = Math.floor(plan.batches.length / 2)
    for (const b of plan.batches.slice(0, half)) live.onBatch(b)
    const early = live.stats()
    expect(early.streaming).toBe(true)
    expect(early.tileCount).toBeGreaterThan(0)
    live.onEvent({ type: 'job.progress', jobId: 7, plannedS: early.headS + 0.5, lineCount: 100, batchCount: half, sampleCount: early.sampleCount, energyJ: early.energyJ })
    expect(live.headS()).toBeCloseTo(early.headS + 0.5)
    expect(live.cutoffS(0.5, false)).toBeCloseTo(live.headS() / 2)
    expect(live.cutoffS(0.1, true)).toBe(live.headS())

    const before = live.store.count
    for (const b of plan.batches.slice(half)) live.onBatch(b)
    const late = live.stats()
    expect(late.sampleCount).toBe(plan.sampleCount)
    expect(late.grid!.height).toBeGreaterThan(early.grid!.height)
    expect(late.tileCount).toBeGreaterThanOrEqual(early.tileCount)
    expect(live.dirtyTiles(live.setup()!, before).length).toBeGreaterThan(0)
    expect(late.missingBatches).toEqual([])

    live.onEvent({ type: 'job.loaded', jobId: 7, job })
    live.onEvent({ type: 'plan.done', jobId: 7, durationS: plan.durationS, batchCount: plan.batches.length, sampleCount: plan.sampleCount, energyJ: plan.energyJ })
    expect(live.stats().streaming).toBe(false)
    expect(live.headS()).toBe(plan.durationS)
    expect(rel(live.store.energyJ, plan.energyJ)).toBeLessThan(1e-9)
  })

  it('reports dropped batches', () => {
    // The fine provisional pitch gives this job several batches.
    const plan = interimSampler.plan(job, machine, 7)
    expect(plan.batches.length).toBeGreaterThan(2)
    const live = new LiveJob(7, 'x', machine, wood)
    live.onBatch(plan.batches[0]!)
    live.onBatch(plan.batches[2]!)
    expect(live.stats().missingBatches).toEqual([1])
  })

  it('job.streaming and job.progress validate against TypeBox and the exported schema', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    ajv.addFormat('uint32', true)
    ajv.addSchema(buildContractSchema())
    const check = ajv.getSchema(`${buildContractSchema().$id as string}#/$defs/ChannelEvent`)!
    const events = [
      { seq: 0, event: { type: 'job.streaming', jobId: 7, name: 'lightburn-job' } },
      { seq: 1, event: { type: 'job.progress', jobId: 7, plannedS: 1.5, lineCount: 120, batchCount: 3, sampleCount: 40000, energyJ: 2.5 } },
    ]
    for (const e of events) {
      expect(validate(ChannelEvent, e)).toEqual([])
      expect(check(e)).toBe(true)
    }
    expect(validate(ChannelEvent, { seq: 2, event: { type: 'job.progress', jobId: 7 } })).not.toEqual([])
  })
})

// SPDX-License-Identifier: MIT
// Browser benchmark for the WebGL2 pipeline against the COD-251/252 pass
// criteria: full-res < 2 s, warm coarse scrub < 50 ms, fluence within 1% at
// every stage; plus GPU-vs-CPU agreement and tiled-vs-untiled seams.
// Timing: wall clock, one sync (finish + 1-pixel readPixels) at the end of a
// pass unless stated "stage-synced".
//
// Run: `pnpm bench` and open the printed URL (or the app's webview).

import birchJson from '../src/profiles/provisional/birch-ply.json'
import machineJson from '../src/profiles/provisional/machine-10w-diode.json'
import { JOB_CELL_BUDGET, decodeSampleBatch, tilePoolBytes, type JobModel, type MachineProfile } from '../src/contract/index.ts'
import {
  CpuPeakTemperatureStep,
  GlBurnView,
  GlContextLostError,
  GlOverview,
  GlSim,
  LiveJob,
  SampleStore,
  interimSampler,
  lastThermalPath,
  ledger,
  peakTemperatureModel,
  planSide,
  watchContextLoss,
  loadMachineProfile,
  loadMaterialProfile,
  detailGrid,
  detailSetup,
  setupJob,
  simulateCpu,
  stitch,
  type GlRunResult,
  type GlThermalResult,
  type SimSetup,
  type StageEnergy,
  type ThermalStep,
} from '../src/sim/index.ts'
import type { MaterialProfile } from '../src/contract/index.ts'
import { concatJobs, rasterJob, squareJob } from '../src/sim/test-jobs.ts'

const out = document.getElementById('out')!
const canvas = document.getElementById('canvas') as HTMLCanvasElement
const lines: string[] = []
const log = (s = '') => {
  lines.push(s)
  out.textContent = lines.join('\n')
}
const ms = (v: number) => `${v.toFixed(1)} ms`
const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return `min ${ms(s[0]!)} / median ${ms(s[Math.floor(s.length / 2)]!)} / max ${ms(s[s.length - 1]!)}`
}
const nextFrame = () => new Promise((r) => setTimeout(r, 0))

const machine = loadMachineProfile(machineJson)
const birch = loadMaterialProfile(birchJson)
/** Birch with the thermal step off: the COD-264 baseline, to measure what the thermal step adds. */
const birchFluence: MaterialProfile = { ...birch, thermal: { kind: 'none' }, fireRisk: { kind: 'none' } }
/** COD-251/252 benchmark spot: round σ = 0.05 mm, pitch σ/3 → 6000² grid for 100 mm. */
const spikeMachine: MachineProfile = { ...machine, spot: { sigmaXMm: 0.05, sigmaYMm: 0.05, angleDeg: 0 } }

const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true })
if (!gl) throw new Error('WebGL2 unavailable')
// Rebuilt after a context loss (BURN-36): everything on the GPU is derived, so recovery is new objects.
let sim = new GlSim(gl)
let overview = new GlOverview(gl, 2048)
let restored: (() => void) | null = null
let lostAt: (() => void) | null = null
const contextWatch = watchContextLoss(canvas, {
  onLost: () => {
    log('webglcontextlost: waiting for restore')
    lostAt?.()
  },
  onRestored: () => {
    sim = new GlSim(gl)
    overview = new GlOverview(gl, 2048)
    log(`webglcontextrestored: rebuilt GlSim (tile side cap ${sim.maxTileSide})`)
    restored?.()
  },
}, gl)
const waitFor = (set: (f: () => void) => void, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs)
    set(() => {
      clearTimeout(t)
      resolve(true)
    })
  })
const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`

function storeFor(job: JobModel, m: MachineProfile) {
  const t0 = performance.now()
  const plan = interimSampler.plan(job, m, 1)
  const t1 = performance.now()
  const store = new SampleStore(1)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  const t2 = performance.now()
  return { store, plan, samplerMs: t1 - t0, storeMs: t2 - t1 }
}

function timedRun(fn: () => GlRunResult): { ms: number; result: GlRunResult } {
  const t0 = performance.now()
  const result = fn()
  sim.sync()
  return { ms: performance.now() - t0, result }
}

function energyTable(label: string, e: StageEnergy): void {
  const r = (v: number) => `${v.toExponential(4)} (${(v / e.expectedJ).toFixed(4)}) ${Math.abs(v / e.expectedJ - 1) <= 0.01 ? 'PASS' : 'FAIL'}`
  log(`  ${label} expected ${e.expectedJ.toExponential(4)} J`)
  log(`    after deposit ${r(e.depositJ)}`)
  log(`    after blur H  ${r(e.blurHJ)}`)
  log(`    after blur V  ${r(e.blurVJ)}`)
}

/** GPU tiles read back and stitched (small jobs only). */
function gpuStitched(store: SampleStore, setup: SimSetup, with_ = sim) {
  const { width, height } = setup.grid
  const fluence = new Float32Array(width * height)
  const color = new Uint8ClampedArray(width * height * 4)
  const verdict = new Uint8Array(width * height)
  with_.run(store, setup, {
    onTile: (v) => {
      const { core, padded } = v.tile
      const local = { x: core.x - padded.x, y: core.y - padded.y, width: core.width, height: core.height }
      const f = v.readFluence(local)
      const c = v.readColor(local)
      const vd = v.readVerdict(local)
      for (let y = 0; y < core.height; y++) {
        fluence.set(f.subarray(y * core.width, (y + 1) * core.width), (core.y + y) * width + core.x)
        verdict.set(vd.subarray(y * core.width, (y + 1) * core.width), (core.y + y) * width + core.x)
        color.set(c.subarray(y * core.width * 4, (y + 1) * core.width * 4), ((core.y + y) * width + core.x) * 4)
      }
    },
  })
  return { fluence, color, verdict }
}

function diff(a: { fluence: Float32Array; color: Uint8ClampedArray; verdict: Uint8Array }, b: typeof a) {
  let maxF = 0
  let peak = 0
  let maxC = 0
  let badC = 0
  let badV = 0
  for (let i = 0; i < a.fluence.length; i++) {
    maxF = Math.max(maxF, Math.abs(a.fluence[i]! - b.fluence[i]!))
    peak = Math.max(peak, Math.abs(b.fluence[i]!))
    if (a.verdict[i] !== b.verdict[i]) badV++
  }
  for (let i = 0; i < a.color.length; i++) {
    const d = Math.abs(a.color[i]! - b.color[i]!)
    maxC = Math.max(maxC, d)
    if (d > 1) badC++
  }
  const n = a.fluence.length
  return `max |Δfluence| ${(maxF / peak).toExponential(2)} of peak · max Δcolour ${maxC} (cells > 1: ${badC}) · verdict mismatches ${badV} / ${n}`
}

export interface BenchReport {
  text: string
  pass: Record<string, boolean>
}

async function run(): Promise<BenchReport> {
  lines.length = 0
  const pass: Record<string, boolean> = {}
  log('== Environment ==')
  log(`user agent: ${navigator.userAgent}`)
  log(`gl renderer: ${sim.caps.renderer}`)
  log(`gl vendor: ${sim.caps.vendor}`)
  log(`MAX_TEXTURE_SIZE ${sim.caps.maxTextureSize} · EXT_float_blend ${sim.caps.floatBlend} · timer query ${sim.caps.timerQuery}`)
  log(`timing: wall clock (performance.now), single sync per pass (finish + readPixels) unless "stage-synced"`)
  log()

  // Warm-up: compile every program and both blur radii on a tiny job.
  const tiny = storeFor(squareJob(1, 1, 1, 1200, 500), spikeMachine)
  const tinySetup = setupJob(tiny.store.burnBounds!, spikeMachine, birch)
  timedRun(() => sim.run(tiny.store, tinySetup, { overview }))
  timedRun(() => sim.runCoarse(tiny.store, tinySetup, Infinity))
  await nextFrame()

  log('== Spike-equivalent job: 100 × 100 mm raster, 0.1 mm interval, σ 0.05 mm, 6000 mm/min, M4 S300, birch ==')
  const big = storeFor(
    rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }),
    spikeMachine,
  )
  const setup = setupJob(big.store.burnBounds!, spikeMachine, birch)
  log(`samples ${big.store.count.toLocaleString()} in ${big.plan.batches.length} batches · job ${big.plan.durationS.toFixed(1)} s`)
  log(`grid ${setup.grid.width} × ${setup.grid.height} @ ${(setup.grid.pitchMm * 1000).toFixed(2)} µm · tiles ${setup.plan.tiles.length} · kernel radius ${setup.separable.x.radius} cells`)
  log(`interim sampler ${ms(big.samplerMs)} · sample store ${ms(big.storeMs)} (CPU, once per job)`)

  const upload = performance.now()
  sim.syncSamples(big.store)
  sim.sync(null)
  log(`sample upload ${ms(performance.now() - upload)} (once per job)`)
  await nextFrame()

  const cold = timedRun(() => sim.run(big.store, setup, { overview }))
  overview.drawToCanvas()
  await nextFrame()
  const warm: number[] = []
  for (let i = 0; i < 10; i++) {
    warm.push(timedRun(() => sim.run(big.store, setup, { overview })).ms)
    await nextFrame()
  }
  const fullMedian = [...warm].sort((a, b) => a - b)[5]!
  pass.fullRes = fullMedian < 2000
  log(`full-res: cold ${ms(cold.ms)} · warm ×10 ${stats(warm)} → < 2 s ${pass.fullRes ? 'PASS' : 'FAIL'}`)
  const staged = sim.run(big.store, setup, { syncStages: true })
  log(`  stage-synced: ${Object.entries(staged.stageMs).map(([k, v]) => `${k} ${ms(v)}`).join(' · ')}`)
  await nextFrame()

  // Coarse scrub: a drag across the timeline, each step at a new cutoff.
  const coldCoarse = timedRun(() => sim.runCoarse(big.store, setup, big.plan.durationS * 0.5, { overview }))
  const coarse: number[] = []
  for (let i = 0; i < 10; i++) {
    const cutoff = big.plan.durationS * (0.1 + 0.09 * i)
    coarse.push(timedRun(() => sim.runCoarse(big.store, setup, cutoff, { overview })).ms)
    await nextFrame()
  }
  const coarseMedian = [...coarse].sort((a, b) => a - b)[5]!
  pass.coarse = coarseMedian < 50
  log(`coarse scrub: first after full-res ${ms(coldCoarse.ms)} · warm ×10 at moving cutoffs ${stats(coarse)} → < 50 ms ${pass.coarse ? 'PASS' : 'FAIL'}`)
  const stagedCoarse = sim.runCoarse(big.store, setup, big.plan.durationS * 0.7, { syncStages: true })
  log(`  stage-synced: ${Object.entries(stagedCoarse.stageMs).map(([k, v]) => `${k} ${ms(v)}`).join(' · ')}`)

  log()
  log('== Fluence conservation (GPU, Σ cell · pitch² over tile cores) ==')
  const eFull = sim.run(big.store, setup, { measureEnergy: true }).energy!
  energyTable('full-res', eFull)
  const eCoarse = sim.runCoarse(big.store, setup, Infinity, { measureEnergy: true }).energy!
  energyTable('coarse', eCoarse)
  const within = (e: StageEnergy) => [e.depositJ, e.blurHJ, e.blurVJ].every((v) => Math.abs(v / e.expectedJ - 1) <= 0.01)
  pass.fluence = within(eFull) && within(eCoarse) && Math.abs(eCoarse.blurVJ / eFull.blurVJ - 1) <= 0.01
  log(`  coarse / full-res after blur V: ${(eCoarse.blurVJ / eFull.blurVJ).toFixed(4)} → ${pass.fluence ? 'PASS' : 'FAIL'}`)

  // Back to the full-res image on the canvas (scrub released).
  sim.run(big.store, setup, { overview })
  overview.drawToCanvas()
  await nextFrame()

  log()
  log('== GPU vs CPU reference, tiled vs untiled (provisional 10 W diode, σ 0.03 × 0.015 mm, birch) ==')
  const small = storeFor(
    concatJobs(
      rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 6, heightMm: 3, intervalMm: 0.08, feedMmPerMin: 4000, s: 350 }),
      squareJob(0.5, 0.5, 7, 900, 800, 'm3'),
    ),
    machine,
  )
  const untiled = setupJob(small.store.burnBounds!, machine, birch)
  const tiled = setupJob(small.store.burnBounds!, machine, birch, { maxTileCells: 700 })
  const cpu = stitch(simulateCpu(small.store, untiled))
  // The GPU tiles hold thermal dose for a material with a thermal model.
  const cpuArrays = { fluence: cpu.dose ?? cpu.fluence.data, color: cpu.color, verdict: cpu.verdict }
  log(`grid ${untiled.grid.width} × ${untiled.grid.height} · tiled plan ${tiled.plan.cols} × ${tiled.plan.rows} tiles of ≤ 700² (margin ${tiled.plan.marginCells})`)
  const gpuUntiled = gpuStitched(small.store, untiled)
  const gpuTiled = gpuStitched(small.store, tiled)
  log(`  GPU untiled vs CPU:    ${diff(gpuUntiled, cpuArrays)}`)
  log(`  GPU tiled vs CPU:      ${diff(gpuTiled, cpuArrays)}`)
  log(`  GPU tiled vs untiled:  ${diff(gpuTiled, gpuUntiled)}`)
  const fallback = new GlSim(gl!, { forceCpuDeposit: true })
  log(`  CPU-deposit fallback (no EXT_float_blend) tiled vs CPU: ${diff(gpuStitched(small.store, tiled, fallback), cpuArrays)}`)
  const cpuEnergy = simulateCpu(small.store, untiled).energy
  const gpuEnergy = sim.run(small.store, tiled, { measureEnergy: true }).energy!
  log(`  energy after blur V: CPU ${cpuEnergy.blurVJ.toExponential(5)} · GPU tiled ${gpuEnergy.blurVJ.toExponential(5)}`)

  log()
  log('== Rotated spot (COD-256): same job, provisional diode spot at 30° (sheared Y pass) ==')
  const rotated: MachineProfile = { ...machine, spot: { ...machine.spot, angleDeg: 30 } }
  const rotUntiled = setupJob(small.store.burnBounds!, rotated, birch)
  const rotTiled = setupJob(small.store.burnBounds!, rotated, birch, { maxTileCells: 700 })
  const rotCpu = stitch(simulateCpu(small.store, rotUntiled))
  const rotCpuArrays = { fluence: rotCpu.dose ?? rotCpu.fluence.data, color: rotCpu.color, verdict: rotCpu.verdict }
  const rotGpuTiled = gpuStitched(small.store, rotTiled)
  log(`skew taps ${rotUntiled.separable.y.radius * 2 + 1} · shear ${rotUntiled.separable.skew?.shear.toFixed(4)} · margin ${rotTiled.plan.marginCells}`)
  log(`  GPU untiled vs CPU:    ${diff(gpuStitched(small.store, rotUntiled), rotCpuArrays)}`)
  log(`  GPU tiled vs CPU:      ${diff(rotGpuTiled, rotCpuArrays)}`)
  energyTable('GPU tiled, rotated', sim.run(small.store, rotTiled, { measureEnergy: true }).energy!)
  const blurMs = (s: SimSetup) => {
    const r: number[] = []
    for (let i = 0; i < 5; i++) {
      const st = sim.run(small.store, s, { syncStages: true }).stageMs
      r.push((st.blurH ?? 0) + (st.blurV ?? 0))
    }
    return r
  }
  log(`  blur H+V, aligned ${stats(blurMs(untiled))} · rotated ${stats(blurMs(rotUntiled))}`)

  // Restore the big job on the canvas.
  sim.run(big.store, setup, { overview })
  overview.drawToCanvas()

  const text = lines.join('\n')
  const report = { text, pass }
  ;(window as unknown as { __bench: BenchReport }).__bench = report
  return report
}

async function runFine(): Promise<void> {
  lines.length = 0
  log('== Provisional-pitch job: 100 × 100 mm raster on the provisional 10 W diode (σ 0.03 × 0.015 mm → 5 µm pitch) ==')
  const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), machine)
  const setup = setupJob(job.store.burnBounds!, machine, birch)
  log(`samples ${job.store.count.toLocaleString()} · sampler ${ms(job.samplerMs)} · store ${ms(job.storeMs)}`)
  log(`grid ${setup.grid.width} × ${setup.grid.height} · tiles ${setup.plan.cols} × ${setup.plan.rows} (padded ≤ ${Math.max(...setup.plan.tiles.map((t) => t.padded.width))}²)`)
  await nextFrame()
  try {
    const first = timedRun(() => sim.run(job.store, setup, { overview }))
    overview.drawToCanvas()
    await nextFrame()
    const second = timedRun(() => sim.run(job.store, setup, { overview }))
    log(`full-res tiled: first ${ms(first.ms)} (includes binning ${setup.plan.tiles.length > 1 ? 'the samples' : '-'}) · second ${ms(second.ms)}`)
    const staged = sim.run(job.store, setup, { syncStages: true })
    log(`  stage-synced: ${Object.entries(staged.stageMs).map(([k, v]) => `${k} ${ms(v)}`).join(' · ')}`)
    const e = sim.run(job.store, setup, { measureEnergy: true }).energy!
    energyTable('full-res tiled', e)
    const firstCoarse = timedRun(() => sim.runCoarse(job.store, setup, job.plan.durationS * 0.1)).ms
    const coarse: number[] = []
    for (let i = 0; i < 10; i++) coarse.push(timedRun(() => sim.runCoarse(job.store, setup, job.plan.durationS * (0.1 + 0.09 * i))).ms)
    log(`coarse scrub: first (builds checkpoints) ${ms(firstCoarse)} · warm ×10 at moving cutoffs ${stats(coarse)}`)
    const stagedCoarse = sim.runCoarse(job.store, setup, job.plan.durationS * 0.7, { syncStages: true })
    log(`  stage-synced: ${Object.entries(stagedCoarse.stageMs).map(([k, v]) => `${k} ${ms(v)}`).join(' · ')}`)
  } catch (err) {
    log(`FAILED: ${String(err)}`)
  }
  log(`gl error: ${gl!.getError()}`)
  sim.releaseTargets()
  ;(window as unknown as { __benchFine: string }).__benchFine = lines.join('\n')
}

/** COD-258: the thermal step on the GPU against the CPU reference, and what it costs. */
async function runThermal(): Promise<void> {
  lines.length = 0
  log('== Thermal step (COD-258): GPU vs CPU reference ==')
  const small = storeFor(
    concatJobs(
      rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 6, heightMm: 3, intervalMm: 0.08, feedMmPerMin: 4000, s: 350 }),
      squareJob(0.5, 0.5, 7, 900, 800, 'm3'),
    ),
    machine,
  )
  const setup = setupJob(small.store.burnBounds!, machine, birch)
  sim.syncSamples(small.store)
  const t0 = performance.now()
  const cpuT = new CpuPeakTemperatureStep().run(small.store, machine, birch, setup.thermalKernel)
  const cpuMs = performance.now() - t0
  const gpuT = sim.thermalStep!.run(small.store, machine, birch, setup.thermalKernel)
  const p = gpuT.plan!
  log(`samples ${small.store.count.toLocaleString()} · job ${small.plan.durationS.toFixed(1)} s · thermal grid ${p.grid.width} × ${p.grid.height} @ ${p.grid.pitchMm.toFixed(3)} mm · bins ${p.binCount} × ${(p.binS * 1000).toFixed(1)} ms (lag ${p.lagBins}) · active ${gpuT.activeBins}`)
  log(`CPU reference ${ms(cpuMs)} · GPU ${ms(gpuT.gpuMs)} (incl. readback)`)
  let maxA = 0
  let maxW = 0
  let maxB = 0
  let peakB = 0
  let badB = 0
  for (let i = 0; i < gpuT.count; i++) {
    maxA = Math.max(maxA, Math.abs(gpuT.eAbs[i]! - cpuT.eAbs[i]!) / cpuT.eAbs[i]!)
    maxW = Math.max(maxW, Math.abs(gpuT.eDose[i]! / gpuT.eAbs[i]! - cpuT.eDose[i]! / cpuT.eAbs[i]!))
  }
  for (let c = 0; c < cpuT.bulkK!.length; c++) {
    const d = Math.abs(gpuT.bulkK![c]! - cpuT.bulkK![c]!)
    maxB = Math.max(maxB, d)
    // A sample on a cell edge can land in either cell (f32 vs f64), so a few cells differ outright.
    if (d > 0.01 * Math.max(cpuT.bulkK![c]!, 1)) badB++
    peakB = Math.max(peakB, cpuT.bulkK![c]!)
  }
  log(`  per-sample eAbs max rel Δ ${maxA.toExponential(2)} · dose weight max |Δ| ${maxW.toExponential(2)} · bulk map max |Δ| ${maxB.toFixed(3)} K of ${peakB.toFixed(0)} K, cells off by > 1 %: ${badB} / ${cpuT.bulkK!.length}`)
  let eAbs = 0
  for (let i = 0; i < gpuT.count; i++) eAbs += gpuT.eAbs[i]!
  log(`  energy: Σ eAbs ${eAbs.toExponential(5)} J (CPU grid holds ${cpuT.grid.energyJ().toExponential(5)} J)`)
  // Pipeline on the same thermal energies (the GPU result is now cached for the CPU too).
  const cpu = stitch(simulateCpu(small.store, setup))
  log(`  pipeline GPU vs CPU (dose):  ${diff(gpuStitched(small.store, setup), { fluence: cpu.dose!, color: cpu.color, verdict: cpu.verdict })}`)
  const tiled = setupJob(small.store.burnBounds!, machine, birch, { maxTileCells: 700 })
  log(`  pipeline GPU tiled vs CPU:   ${diff(gpuStitched(small.store, tiled), { fluence: cpu.dose!, color: cpu.color, verdict: cpu.verdict })}`)
  energyTable('GPU dose, untiled', sim.run(small.store, setup, { measureEnergy: true }).energy!)
  await nextFrame()

  const cost = async (label: string, m: MachineProfile) => {
    log()
    log(`== Cost: ${label} ==`)
    const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), m)
    const withT = setupJob(job.store.burnBounds!, m, birch)
    const without = setupJob(job.store.burnBounds!, m, birchFluence)
    log(`samples ${job.store.count.toLocaleString()} · job ${job.plan.durationS.toFixed(0)} s · grid ${withT.grid.width} × ${withT.grid.height} · tiles ${withT.plan.tiles.length}`)
    sim.syncSamples(job.store)
    sim.run(job.store, without)
    sim.sync()
    await nextFrame()
    const base: number[] = []
    for (let i = 0; i < 3; i++) {
      base.push(timedRun(() => sim.run(job.store, without, { overview })).ms)
      await nextFrame()
    }
    const thermalRuns: GlThermalResult[] = []
    for (let i = 0; i < 3; i++) {
      thermalRuns.push(sim.thermalStep!.run(job.store, m, birch, withT.thermalKernel))
      await nextFrame()
    }
    const tp = thermalRuns[0]!.plan!
    log(`thermal grid ${tp.grid.width} × ${tp.grid.height} @ ${tp.grid.pitchMm.toFixed(3)} mm · bins ${tp.binCount} × ${(tp.binS * 1000).toFixed(0)} ms (lag ${tp.lagBins}) · active ${thermalRuns[0]!.activeBins}`)
    log(`thermal step (once per job/material, incl. statics and readback): ${stats(thermalRuns.map((r) => r.gpuMs))}`)
    const tm = thermalRuns[thermalRuns.length - 1]!.timing
    log(`  last run: CPU statics ${ms(tm.staticsMs)} · GPU bin loop ${ms(tm.loopMs)} · readback + bulk map ${ms(tm.readbackMs)}`)
    // Warm full-res with the thermal result cached: the per-run cost of depositing dose.
    const first = timedRun(() => sim.run(job.store, withT, { overview })).ms
    const warm: number[] = []
    for (let i = 0; i < 3; i++) {
      warm.push(timedRun(() => sim.run(job.store, withT, { overview })).ms)
      await nextFrame()
    }
    log(`full-res: fluence only ${stats(base)} · thermal, first (uploads bulk map) ${ms(first)} · warm ${stats(warm)}`)
    const coarse: number[] = []
    for (let i = 0; i < 5; i++) coarse.push(timedRun(() => sim.runCoarse(job.store, withT, job.plan.durationS * (0.1 + 0.18 * i))).ms)
    log(`coarse scrub with thermal: ${stats(coarse)}`)
    energyTable('full-res dose', sim.run(job.store, withT, { measureEnergy: true }).energy!)
    overview.drawToCanvas()
    sim.releaseTargets()
    await nextFrame()
  }
  try {
    await cost('spike job, σ 0.05 mm, 100 × 100 mm raster', spikeMachine)
    await cost('provisional diode, 5 µm pitch, 100 × 100 mm raster', machine)
  } catch (err) {
    log(`FAILED: ${String(err)}`)
  }
  log(`gl error: ${gl!.getError()}`)
  ;(window as unknown as { __benchThermal: string }).__benchThermal = lines.join('\n')
}

/**
 * BURN-33 / BURN-35: what one live (network) refresh costs as a streamed job
 * grows. Replays the app's refresh (aria-burn burn.svelte.ts scheduleLive →
 * tick): new batches arrive, the setup is rebuilt on live tiling, then a
 * coarse run at the live head. The thermal step continues over the new bins
 * (BURN-35, path "incr") unless the live thermal plan changed ("full"); the
 * "before" replay forces a full rerun every refresh, as before BURN-35.
 * The app waits max(100 ms, 2 × last refresh) before the next one.
 */
async function runLive(chunkCounts = [10, 40], only?: number[]): Promise<void> {
  lines.length = 0
  log('== Live job (BURN-33 / BURN-35): cost of one refresh as the stream grows ==')
  log(`user agent: ${navigator.userAgent}`)
  log(`gl renderer: ${sim.caps.renderer}`)
  log(`page visible: ${document.visibilityState}`)
  log(`gl error before: ${gl!.getError()}`)
  const gpuStep = sim.thermalStep
  /** The GPU step without extend: every refresh reruns in full (the pre-BURN-35 behaviour). */
  const fullOnly: ThermalStep | undefined = gpuStep ? { id: gpuStep.id, run: (...a) => gpuStep.run(...a) } : undefined
  const replay = async (label: string, m: MachineProfile, material: MaterialProfile, steps: number, mode: 'before' | 'after') => {
    log()
    log(`== ${label} · ${steps} chunks · ${mode === 'before' ? 'before: full thermal rerun every refresh' : 'after: incremental (BURN-35)'} ==`)
    const { plan } = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), m)
    const live = new LiveJob(1, 'bench', m, material)
    const n = plan.batches.length
    const thermal = !!peakTemperatureModel(material)
    log(`batches ${n} · job ${plan.durationS.toFixed(0)} s · ${steps} refreshes`)
    log('streamed | samples    | new       | tiles | setup    | thermal   | path | bins  | coarse   | refresh  | next wait')
    let fed = 0
    let lastRefresh = 0
    const refreshes: number[] = []
    const byPath: Record<string, { thermal: number[]; refresh: number[] }> = { incr: { thermal: [], refresh: [] }, full: { thermal: [], refresh: [] } }
    for (let i = 1; i <= steps; i++) {
      const before = live.store.count
      const upTo = Math.round((n * i) / steps)
      for (; fed < upTo; fed++) live.onBatch(plan.batches[fed]!)
      const t0 = performance.now()
      let setup = live.setup()!
      if (mode === 'before' && fullOnly) setup = { ...setup, thermalStep: fullOnly }
      const t1 = performance.now()
      // The thermal step first (it doesn't depend on the tile plan), so fit() below finds it cached.
      sim.syncSamples(live.store)
      sim.thermal(live.store, setup)
      sim.sync()
      const t2 = performance.now()
      const path = !thermal ? '-' : lastThermalPath === 'extended' ? 'incr' : lastThermalPath === 'full' ? 'full' : lastThermalPath ?? '-'
      const bins = thermal && gpuStep?.current ? String(gpuStep.current.activeBins) : '-'
      const tf = performance.now()
      setup = sim.fit(live.store, setup)
      const fitMs = performance.now() - tf
      const tc = performance.now()
      sim.runCoarse(live.store, setup, live.cutoffS(1, true))
      sim.sync()
      const t3 = performance.now()
      lastRefresh = t3 - t0
      refreshes.push(lastRefresh)
      byPath[path]?.thermal.push(t2 - t1)
      byPath[path]?.refresh.push(lastRefresh)
      const pct = `${Math.round((100 * i) / steps)} %`.padStart(8)
      const count = live.store.count.toLocaleString().padStart(10)
      const added = (live.store.count - before).toLocaleString().padStart(9)
      const tiles = String(setup.plan.tiles.length).padStart(5)
      log(
        `${pct} | ${count} | ${added} | ${tiles} | ${ms(t1 - t0 + fitMs).padStart(8)} | ${ms(t2 - t1).padStart(9)} | ${path.padStart(4)} | ${bins.padStart(5)} | ${ms(t3 - tc).padStart(8)} | ${ms(lastRefresh).padStart(8)} | ${ms(Math.max(100, 2 * lastRefresh)).padStart(8)}`,
      )
      await nextFrame()
    }
    log(`refresh: ${stats(refreshes)} · last ${ms(lastRefresh)} → the app's next refresh waits ${ms(Math.max(100, 2 * lastRefresh))}`)
    for (const [k, v] of Object.entries(byPath))
      if (v.refresh.length) log(`  ${k}: ${v.refresh.length} refreshes · thermal ${stats(v.thermal)} · refresh ${stats(v.refresh)}`)
    if (thermal && mode === 'after' && gpuStep) {
      // The incremental result against a full rerun of the same store under the same live plan.
      const setup = sim.fit(live.store, live.setup()!)
      const inc = sim.thermal(live.store, setup)!
      const incAbs = inc.eAbs.slice()
      const incDose = inc.eDose.slice()
      const incBulk = inc.bulkK!.slice()
      const full = gpuStep.run(live.store, m, material, setup.thermalKernel, 'live')
      let maxA = 0
      let maxW = 0
      let maxB = 0
      let peakB = 0
      let badB = 0
      for (let j = 0; j < full.count; j++) {
        maxA = Math.max(maxA, Math.abs(incAbs[j]! - full.eAbs[j]!) / full.eAbs[j]!)
        maxW = Math.max(maxW, Math.abs(incDose[j]! / incAbs[j]! - full.eDose[j]! / full.eAbs[j]!))
      }
      for (let c = 0; c < full.bulkK!.length; c++) {
        const d = Math.abs(incBulk[c]! - full.bulkK![c]!)
        maxB = Math.max(maxB, d)
        if (d > 0.01 * Math.max(full.bulkK![c]!, 1)) badB++
        peakB = Math.max(peakB, full.bulkK![c]!)
      }
      const p = full.plan!
      log(`  live thermal plan at the end: grid ${p.grid.width} × ${p.grid.height} @ ${p.grid.pitchMm.toFixed(3)} mm · bins ${p.binCount} × ${(p.binS * 1000).toFixed(0)} ms (lag ${p.lagBins})`)
      log(`  incremental vs full rerun (GPU, same store and plan): per-sample eAbs max rel Δ ${maxA.toExponential(2)} · dose weight max |Δ| ${maxW.toExponential(2)} · bulk map max |Δ| ${maxB.toFixed(3)} K of ${peakB.toFixed(0)} K, cells off by > 1 %: ${badB} / ${full.bulkK!.length}`)
    }
    log(`gl error after replay: ${gl!.getError()}`)
    sim.releaseTargets()
    await nextFrame()
  }
  const cases: [string, MachineProfile, MaterialProfile][] = [
    ['spike job, σ 0.05 mm, 100 × 100 mm raster, birch (thermal)', spikeMachine, birch],
    ['spike job, fluence only (no thermal step)', spikeMachine, birchFluence],
    ['provisional diode, 5 µm pitch, 100 × 100 mm raster, birch (thermal)', machine, birch],
  ]
  try {
    for (const i of only ?? cases.keys()) {
      const [label, m, material] = cases[i]!
      if (peakTemperatureModel(material)) await replay(label, m, material, chunkCounts[0]!, 'before')
      for (const steps of chunkCounts) await replay(label, m, material, steps, 'after')
    }
  } catch (err) {
    log(`FAILED: ${String(err)}`)
  }
  log(`gl error: ${gl!.getError()}`)
  ;(window as unknown as { __benchLive: string }).__benchLive = lines.join('\n')
}

/**
 * BURN-36: what this GPU actually allocates, and whether the byte budget,
 * smaller-tile fallback and context recovery hold. Run it in a fresh browser
 * process: an earlier context loss in the same process may skew the numbers.
 *   1. Step a full tile pool up in size (alone, then beside a 4096² overview
 *      as the app's burn view keeps) until the GPU refuses it.
 *   2. The 5 µm 100 mm job, planned with GlSim.tileSide().
 *   3. A forced allocation failure (failPoolAboveBytes) on the spike job: it must fall back and conserve energy.
 *   4. Lose and restore the context (WEBGL_lose_context), rebuild, re-run.
 */
async function runTiles(): Promise<void> {
  lines.length = 0
  const pass: Record<string, boolean> = {}
  log('== Tile budget (BURN-36) ==')
  log(`user agent: ${navigator.userAgent}`)
  log(`gl renderer: ${sim.caps.renderer}`)
  log(`MAX_TEXTURE_SIZE ${sim.caps.maxTextureSize} · MAX_RENDERBUFFER_SIZE ${sim.caps.maxRenderbufferSize}`)
  log(`gl error before: ${gl!.getError()} · budget ${mb(sim.gpuBudgetBytes)} · tile side now ${sim.tileSide()} · resident ${mb(ledger(gl!).total)}`)
  sim.releaseTargets()

  const sides = [2048, 3072, 4096, 4608, 5120, 5632, 6016, 6400, 6711, 7168, 7680, 8192, 8704, 9000]
  const step = async (label: string, withOverview: boolean): Promise<number> => {
    log()
    log(`-- pool step: ${label} --`)
    const big = withOverview ? new GlOverview(gl!) : null
    big?.resize(20000, 20000)
    if (big) log(`overview ${big.width}² resident: ${mb(ledger(gl!).total)}`)
    let largest = 0
    for (const side of sides) {
      const t0 = performance.now()
      try {
        const bytes = sim.probePool(side)
        largest = side
        log(`  ${String(side).padStart(5)}² pool ${mb(bytes).padStart(9)} · resident ${mb(ledger(gl!).total).padStart(9)} · ok ${ms(performance.now() - t0)}`)
      } catch (e) {
        const lost = gl!.isContextLost()
        log(`  ${String(side).padStart(5)}² pool ${mb(tilePoolBytes(side, side)).padStart(9)} · REFUSED ${String(e)}${lost ? ' · CONTEXT LOST' : ''}`)
        if (lost) {
          const back = await waitFor((f) => (restored = f), 10000)
          log(back ? '  context restored' : '  context NOT restored within 10 s')
          return largest
        }
        break
      }
      await nextFrame()
    }
    sim.releaseTargets()
    big?.dispose()
    log(`  largest pool that allocated: ${largest ? `${largest}² (${mb(tilePoolBytes(largest, largest))})` : 'none'}`)
    return largest
  }
  const alone = await step('pool alone', false)
  const beside = await step('beside a 4096² overview (the burn view)', true)
  log()
  log(`suggested GPU budget: ~${mb(tilePoolBytes(beside || alone, beside || alone) + (beside ? 464e6 : 0))} (largest pool beside the overview, plus the overview)`)

  log()
  log('-- 5 µm 100 mm job, planned with GlSim.fit() --')
  try {
    const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), machine)
    const setup = sim.fit(job.store, setupJob(job.store.burnBounds!, machine, birch), overview)
    log(`samples ${job.store.count.toLocaleString()} · grid ${setup.grid.width} × ${setup.grid.height} · tiles ${setup.plan.cols} × ${setup.plan.rows} (padded ≤ ${planSide(setup.plan)}) · resident before the pool ${mb(ledger(gl!).total)}`)
    const first = timedRun(() => sim.run(job.store, setup, { overview }))
    overview.drawToCanvas()
    await nextFrame()
    const second = timedRun(() => sim.run(job.store, setup, { overview }))
    const r = second.result
    log(`first ${ms(first.ms)} · second ${ms(second.ms)} · ran ${r.tileCount} tiles (padded ≤ ${planSide(r.plan)}) · replanned ${r.replanned} · failed sides ${r.failedSides.join(', ') || 'none'}`)
    log(`resident after: ${mb(ledger(gl!).total)} · context lost: ${gl!.isContextLost()}`)
    pass['5 µm job renders without context loss'] = !gl!.isContextLost()
  } catch (e) {
    log(`FAILED: ${String(e)}`)
    pass['5 µm job renders without context loss'] = false
    if (e instanceof GlContextLostError) await waitFor((f) => (restored = f), 10000)
  }
  sim.releaseTargets()

  log()
  log('-- forced allocation failure: spike job, pools over 2048² refused --')
  try {
    const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), spikeMachine)
    const setup = setupJob(job.store.burnBounds!, spikeMachine, birchFluence)
    const forced = new GlSim(gl!, { failPoolAboveBytes: tilePoolBytes(2048, 2048) })
    const r = forced.run(job.store, setup, { measureEnergy: true })
    const e = r.energy!
    const ok = r.failedSides.length > 0 && planSide(r.plan) <= 2048 && Math.abs(e.blurVJ / e.expectedJ - 1) <= 0.01
    log(`setup tile ${planSide(setup.plan)} → ran ${r.tileCount} tiles ≤ ${planSide(r.plan)} · failed ${r.failedSides.join(', ')} · learned cap ${forced.maxTileSide}`)
    energyTable('after fallback', e)
    pass['forced failure falls back to smaller tiles'] = ok
    forced.releaseTargets()
  } catch (e) {
    log(`FAILED: ${String(e)}`)
    pass['forced failure falls back to smaller tiles'] = false
  }

  log()
  log('-- context loss and recovery (WEBGL_lose_context) --')
  const lose = gl!.getExtension('WEBGL_lose_context')
  if (!lose) log('WEBGL_lose_context unavailable: skipped')
  else {
    const lostP = waitFor((f) => (lostAt = f), 5000)
    lose.loseContext()
    const wasLost = await lostP
    // restoreContext is ignored until the lost event has finished dispatching (Chrome).
    await new Promise((r) => setTimeout(r, 50))
    let threw = ''
    try {
      sim.run(storeFor(squareJob(5, 5, 10, 900, 600), spikeMachine).store, setupJob({ minXMm: 4, minYMm: 4, maxXMm: 16, maxYMm: 16 }, spikeMachine, birchFluence))
    } catch (e) {
      threw = e instanceof GlContextLostError ? 'GlContextLostError' : String(e)
    }
    const backP = waitFor((f) => (restored = f), 5000)
    lose.restoreContext()
    const back = await backP
    let reran = false
    try {
      const small = storeFor(squareJob(5, 5, 10, 900, 600), spikeMachine)
      const r = sim.run(small.store, setupJob(small.store.burnBounds!, spikeMachine, birchFluence), { overview })
      overview.drawToCanvas()
      reran = r.sampleCount > 0 && !gl!.isContextLost()
    } catch (e) {
      log(`re-run FAILED: ${String(e)}`)
    }
    log(`lost event ${wasLost} · run on lost context threw ${threw || 'nothing'} · restored ${back} · re-run after rebuild ${reran} · losses seen ${contextWatch.losses}`)
    pass['context loss recovers'] = wasLost && threw === 'GlContextLostError' && back && reran
  }
  log()
  for (const [k, v] of Object.entries(pass)) log(`${v ? 'PASS' : 'FAIL'}  ${k}`)
  log(`gl error: ${gl!.getError()}`)
  ;(window as unknown as { __benchTiles: string }).__benchTiles = lines.join('\n')
}
;(window as unknown as { __runTiles: typeof runTiles }).__runTiles = runTiles

/**
 * BURN-36 follow-up: which step of a 5 µm run kills the context in WebView2
 * on Iris Xe. Each GPU step runs alone, then finish + a 1-pixel readback, then
 * a context check, so the first step that loses the context (or runs near
 * Windows' ~2 s GPU timeout) is named. Fluence-only first, then with the
 * thermal step. Run each browser in a fresh process.
 */
async function runStages(): Promise<void> {
  lines.length = 0
  const results: Record<string, string> = {}
  log('== Upload stages (BURN-36): 5 µm 100 mm job, one GPU step at a time ==')
  log(`user agent: ${navigator.userAgent}`)
  log(`gl renderer: ${sim.caps.renderer}`)
  log(`gl error before: ${gl!.getError()} · budget ${mb(sim.gpuBudgetBytes)}`)
  log('Each line: wall time incl. CPU work, finish + 1-pixel readback · resident after · gl error · context lost')
  log('SLOW marks steps over 1.8 s of wall time; Windows resets the GPU when one GPU command runs past ~2 s (TDR),')
  log('so a slow step that then loses the context is the suspect. Check Event Viewer for display event 4101.')
  const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), machine)
  log(`samples ${job.store.count.toLocaleString()} (${mb(job.store.count * 12)} xye) · CPU sampler ${ms(job.samplerMs)} · store ${ms(job.storeMs)}`)

  const runCase = async (label: string, material: MaterialProfile): Promise<void> => {
    log()
    log(`-- ${label} --`)
    sim.releaseTargets()
    const big = new GlOverview(gl!)
    const setup = setupJob(job.store.burnBounds!, machine, material)
    const stage = async (name: string, fn: () => void): Promise<boolean> => {
      const t0 = performance.now()
      let err = ''
      try {
        fn()
        sim.sync()
      } catch (e) {
        err = String(e)
      }
      const t = performance.now() - t0
      const glErr = gl!.getError()
      const lost = gl!.isContextLost()
      log(`  ${name.padEnd(34)} ${ms(t).padStart(10)} · resident ${mb(ledger(gl!).total).padStart(9)} · gl error ${glErr} · lost ${lost}${t > 1800 ? ' · SLOW (> 1.8 s wall)' : ''}${err ? ` · ${err}` : ''}`)
      await nextFrame()
      const ok = !lost && !err && glErr === 0
      if (!ok) results[label] = `failed at: ${name}`
      return ok
    }
    const steps: [string, () => void][] = [
      ['1. upload samples (skipped if on GPU)', () => sim.syncSamples(job.store)],
      ['2. thermal step', () => void sim.thermal(job.store, setup)],
      ['3. upload bins (bufferData)', () => void sim.ensureBins(job.store, setup)],
      ['4. overview 4096² (burn view size)', () => big.resize(setup.grid.width, setup.grid.height)],
      ['5. tile pool 1024²', () => void sim.probePool(1024)],
      ['6. one 1024² region run', () => void sim.run(job.store, setup, { region: { x: 9500, y: 9500, width: 1000, height: 1000 } })],
    ]
    for (const [name, fn] of steps) if (!(await stage(name, fn))) break
    if (!results[label]) {
      const fitted = sim.fit(job.store, setup, big)
      const ok = await stage(`7. full run, ${fitted.plan.tiles.length} tiles ≤ ${planSide(fitted.plan)}`, () => void sim.run(job.store, fitted, { overview: big }))
      if (ok) results[label] = 'all steps ok'
    }
    if (gl!.isContextLost()) {
      log('  waiting for the context to come back…')
      const back = await waitFor((f) => (restored = f), 15000)
      log(back ? '  restored and rebuilt' : '  NOT restored within 15 s: later cases are skipped')
      if (!back) throw new GlContextLostError()
    } else {
      big.dispose()
      sim.releaseTargets()
    }
  }
  try {
    await runCase('fluence only (no thermal step)', birchFluence)
    await runCase('birch with the thermal step', birch)
  } catch (e) {
    log(`STOPPED: ${String(e)}`)
  }
  log()
  for (const [k, v] of Object.entries(results)) log(`${k}: ${v}`)
  log(`gl error: ${gl!.getError()}`)
  ;(window as unknown as { __benchStages: string }).__benchStages = lines.join('\n')
}

/** Quick loop for tuning: thermal step only, on the spike job (store cached across calls). */
let costStore: ReturnType<typeof storeFor> | null = null
async function thermalCost(runs = 2): Promise<string> {
  costStore ??= storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), spikeMachine)
  const setup = setupJob(costStore.store.burnBounds!, spikeMachine, birch)
  sim.syncSamples(costStore.store)
  const out: string[] = []
  for (let i = 0; i < runs; i++) {
    const r = sim.thermalStep!.run(costStore.store, spikeMachine, birch, setup.thermalKernel)
    out.push(`${ms(r.gpuMs)} (statics ${ms(r.timing.staticsMs)} · loop ${ms(r.timing.loopMs)} · bulk ${ms(r.timing.readbackMs)}) bins ${r.activeBins} · grid ${r.plan!.grid.width}² @ ${r.plan!.grid.pitchMm.toFixed(3)} mm`)
    await nextFrame()
  }
  return out.join('\n')
}
;(window as unknown as { __thermalCost: typeof thermalCost }).__thermalCost = thermalCost

document.getElementById('thermal')!.addEventListener('click', () => void runThermal().catch((e) => log(`ERROR ${String(e)}`)))
;(window as unknown as { __runThermal: typeof runThermal }).__runThermal = runThermal
document.getElementById('live')!.addEventListener('click', () => void runLive().catch((e) => log(`ERROR ${String(e)}`)))
;(window as unknown as { __runLive: typeof runLive }).__runLive = runLive
document.getElementById('stages')!.addEventListener('click', () => void runStages().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('tiles')!.addEventListener('click', () => void runTiles().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('run')!.addEventListener('click', () => void run().catch((e) => log(`ERROR ${String(e)}`)))
/**
 * BURN-37: the 5 µm 100 mm job with the job pitch under a cell budget. Full-res
 * at k = 1, at this GPU's default budget and at the Iris Xe budget, then a
 * 1:1 detail run at the 5 µm detail pitch over a 1920 × 1080 view.
 */
async function runPitch(): Promise<void> {
  lines.length = 0
  const pass: Record<string, boolean> = {}
  log(`== Job pitch under a cell budget (BURN-37) · ${sim.caps.renderer} ==`)
  const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), machine)
  log(`samples ${job.store.count.toLocaleString()} · birch with the thermal step`)
  const budgets: [string, number][] = [
    ['none (k = 1)', Infinity],
    [`this GPU's default (${(sim.cellBudget / 1e6).toFixed(0)} M)`, sim.cellBudget],
  ]
  if (sim.cellBudget !== JOB_CELL_BUDGET) budgets.push([`Iris Xe (${(JOB_CELL_BUDGET / 1e6).toFixed(0)} M)`, JOB_CELL_BUDGET])
  let last: SimSetup | null = null
  for (const [label, cellBudget] of budgets) {
    log()
    log(`-- budget ${label} --`)
    try {
      const setup = sim.fit(job.store, setupJob(job.store.burnBounds!, machine, birch, { cellBudget }), overview)
      const k = Math.round(setup.grid.pitchMm / setup.detailPitchMm)
      log(`pitch ${(setup.grid.pitchMm * 1000).toFixed(1)} µm (k = ${k}) · grid ${setup.grid.width} × ${setup.grid.height} = ${((setup.grid.width * setup.grid.height) / 1e6).toFixed(1)} M cells · tiles ${setup.plan.cols} × ${setup.plan.rows}`)
      const first = timedRun(() => sim.run(job.store, setup, { overview }))
      overview.drawToCanvas()
      await nextFrame()
      const warm: number[] = []
      for (let i = 0; i < 3; i++) {
        warm.push(timedRun(() => sim.run(job.store, setup, { overview })).ms)
        await nextFrame()
      }
      log(`full-res: first ${ms(first.ms)} (the thermal step already ran in GlSim.fit, untimed) · warm ×3 ${stats(warm)}`)
      energyTable('full-res', sim.run(job.store, setup, { measureEnergy: true }).energy!)
      pass[`budget ${label}: warm full-res < 2 s`] = Math.min(...warm) < 2000
      last = setup
    } catch (e) {
      log(`FAILED: ${String(e)}`)
      if (e instanceof GlContextLostError) await waitFor((f) => (restored = f), 10000)
    }
    sim.releaseTargets()
  }
  if (last) {
    log()
    log('-- detail view at the 5 µm detail pitch (1920 × 1080 cells around the job centre) --')
    const burn = new GlBurnView(sim)
    try {
      const g = detailGrid(last)
      const rect = { x: Math.floor(g.width / 2) - 960, y: Math.floor(g.height / 2) - 540, width: 1920, height: 1080 }
      const cutoff = Infinity
      const first = timedRun(() => burn.runDetail(job.store, last!, rect, cutoff)).ms
      const warm: number[] = []
      for (let i = 0; i < 5; i++) warm.push(timedRun(() => burn.runDetail(job.store, last!, { ...rect, x: rect.x + 37 * i }, cutoff)).ms)
      const layer = burn.detail
      log(`detail grid ${g.width} × ${g.height} @ ${(g.pitchMm * 1000).toFixed(1)} µm · layer texel ${layer ? (layer.texelMm * 1000).toFixed(1) : '-'} µm · first ${ms(first)} (bins the samples at the detail pitch) · warm ×5 (panning) ${stats(warm)}`)
      pass['detail layer at the detail pitch'] = !!layer && Math.abs(layer.texelMm - last.detailPitchMm) < 1e-9
    } catch (e) {
      log(`FAILED: ${String(e)}`)
    }
    burn.dispose()
    sim.releaseTargets()
  }
  log()
  for (const [k, v] of Object.entries(pass)) log(`${v ? 'PASS' : 'FAIL'} ${k}`)
  ;(window as unknown as { __benchPitch: string }).__benchPitch = lines.join('\n')
}

/**
 * BURN-41: the first detail run. Same 5 µm 100 mm job and 1920 × 1080-cell
 * view as runPitch, at this GPU's default cell budget and at the Iris Xe one.
 * Each budget times the app's sequence (fit, full run, first detail run, pans)
 * and the BURN-37 bench's (releaseTargets between the full and the detail
 * run, so the detail run also re-uploads the thermal step's per-sample
 * energies), and the pre-BURN-41 cost of that run (whole-job bins built in
 * it). Then a readback of the detail run from window bins and from whole-job
 * bins, compared bit for bit.
 */
async function runDetailBench(): Promise<void> {
  lines.length = 0
  const pass: Record<string, boolean> = {}
  log(`== First detail run (BURN-41) · ${sim.caps.renderer} ==`)
  log(`userAgent ${navigator.userAgent} · page ${document.visibilityState}`)
  const job = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), machine)
  log(`samples ${job.store.count.toLocaleString()} · birch with the thermal step · view 1920 × 1080 cells at the detail pitch, centred`)
  const store = job.store
  const budgets: [string, number][] = [[`this GPU's default (${(sim.cellBudget / 1e6).toFixed(0)} M)`, sim.cellBudget]]
  if (sim.cellBudget !== JOB_CELL_BUDGET) budgets.push([`Iris Xe (${(JOB_CELL_BUDGET / 1e6).toFixed(0)} M)`, JOB_CELL_BUDGET])
  const synced = (fn: () => unknown) => {
    const t0 = performance.now()
    fn()
    sim.sync()
    return performance.now() - t0
  }
  let lastSetup: SimSetup | null = null
  for (const [label, cellBudget] of budgets) {
    log()
    log(`-- budget ${label} --`)
    sim.releaseTargets()
    const burn = new GlBurnView(sim)
    burn.setMaterial(birch)
    try {
      let setup = setupJob(store.burnBounds!, machine, birch, { cellBudget })
      const fitMs = synced(() => (setup = sim.fit(store, setup, burn.full)))
      const k = Math.round(setup.grid.pitchMm / setup.detailPitchMm)
      const binnedByFit = sim.hasBins(store, setup)
      const fullMs = synced(() => burn.runFull(store, setup, Infinity))
      const g = detailGrid(setup)
      const rect = { x: Math.floor(g.width / 2) - 960, y: Math.floor(g.height / 2) - 540, width: 1920, height: 1080 }
      log(`job pitch ${(setup.grid.pitchMm * 1000).toFixed(1)} µm (k = ${k}) · tiles ${setup.plan.cols} × ${setup.plan.rows} · fit ${ms(fitMs)} (thermal step${binnedByFit ? ' + whole-job bins: multi-tile plan' : ', no bins: one tile'}) · full run ${ms(fullMs)}`)
      await nextFrame()
      // 1. The app's sequence: the detail run right after the full run.
      const app = synced(() => burn.runDetail(store, setup, rect, Infinity))
      const binsApp = binnedByFit ? 'whole-job bins from fit' : 'window bins'
      const pans: number[] = []
      for (let i = 1; i <= 5; i++) pans.push(synced(() => burn.runDetail(store, setup, { ...rect, x: rect.x + 37 * i }, Infinity)))
      // Far pans: a view width each time, past any window built around the first view.
      const far: number[] = []
      for (let i = 1; i <= 3; i++) far.push(synced(() => burn.runDetail(store, setup, { ...rect, x: rect.x - 1920 * i }, Infinity)))
      log(`app sequence: first detail ${ms(app)} (${binsApp}) · pans ×5 (37 cells) ${stats(pans)} · far pans ×3 (1920 cells) ${stats(far)}`)
      pass[`budget ${label}: first detail run, app sequence < 2 s`] = app < 2000
      await nextFrame()
      // 2. The BURN-37 bench's sequence: releaseTargets before the detail run.
      sim.releaseTargets()
      const afterRelease = synced(() => burn.runDetail(store, setup, rect, Infinity))
      log(`after releaseTargets (BURN-37 bench sequence): first detail ${ms(afterRelease)} (thermal re-upload + window bins)`)
      pass[`budget ${label}: first detail run after releaseTargets < 2 s`] = afterRelease < 2000
      await nextFrame()
      // 3. Before BURN-41: the same, with the whole-job bins built in the detail run.
      sim.releaseTargets()
      const thermalMs = synced(() => sim.thermal(store, setup))
      const binsMs = synced(() => sim.ensureBins(store, setup))
      const runMs = synced(() => burn.runDetail(store, setup, rect, Infinity))
      log(`before BURN-41 (whole-job bins in the detail run): ${ms(thermalMs + binsMs + runMs)} = thermal re-upload ${ms(thermalMs)} + whole-job bins ${ms(binsMs)} + run ${ms(runMs)}`)
      lastSetup = setup
    } catch (e) {
      log(`FAILED: ${String(e)}`)
      if (e instanceof GlContextLostError) await waitFor((f) => (restored = f), 10000)
    }
    burn.dispose()
    sim.releaseTargets()
    await nextFrame()
  }
  if (lastSetup) {
    log()
    log('-- window bins vs whole-job bins: detail readback, bit for bit --')
    const setup = lastSetup
    const g = detailGrid(setup)
    const views = [
      { x: Math.floor(g.width / 2) - 960, y: Math.floor(g.height / 2) - 540, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: g.width - 700, y: g.height - 500, width: 700, height: 500 },
    ]
    const read = (rect: { x: number; y: number; width: number; height: number }, cutoff: number) => {
      let got: { fluence: Float32Array; color: Uint8ClampedArray; verdict: Uint8Array; depth: Float32Array } | null = null
      sim.run(store, detailSetup(setup), {
        region: rect,
        timeCutoffS: cutoff,
        onTile: (t) => {
          const { core, padded } = t.tile
          const local = { x: core.x - padded.x, y: core.y - padded.y, width: core.width, height: core.height }
          got = { fluence: t.readFluence(local), color: t.readColor(local), verdict: t.readVerdict(local), depth: t.readDepth(local) }
        },
      })
      return got!
    }
    const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      if (a.length !== b.length) return false
      const fa = new Uint8Array((a as Float32Array).buffer, (a as Float32Array).byteOffset, (a as Float32Array).byteLength)
      const fb = new Uint8Array((b as Float32Array).buffer, (b as Float32Array).byteOffset, (b as Float32Array).byteLength)
      if (fa.length !== fb.length) return false
      for (let i = 0; i < fa.length; i++) if (fa[i] !== fb[i]) return false
      return true
    }
    const duration = store.tS[store.count - 1]!
    let all = true
    for (const rect of views) {
      for (const cutoff of [Infinity, duration * 0.5]) {
        sim.releaseTargets()
        sim.thermal(store, setup)
        const usedWindow = !sim.hasBins(store, setup)
        const a = read(rect, cutoff)
        sim.ensureBins(store, setup)
        const b = read(rect, cutoff)
        const ok = usedWindow && same(a.fluence, b.fluence) && same(a.color, b.color) && same(a.verdict, b.verdict) && same(a.depth, b.depth)
        let nonZero = 0
        for (const v of a.fluence) if (v !== 0) nonZero++
        log(`rect ${rect.width} × ${rect.height} at (${rect.x}, ${rect.y}) · cutoff ${cutoff === Infinity ? 'end' : `${cutoff.toFixed(0)} s`} · ${nonZero.toLocaleString()} burnt cells · ${usedWindow ? 'window' : 'WHOLE (not a window run)'} vs whole: ${ok ? 'bit-identical' : 'DIFFERENT'}`)
        all &&= ok
      }
    }
    pass['window bins: detail readback bit-identical to whole-job bins'] = all
    sim.releaseTargets()
  }
  log()
  for (const [k, v] of Object.entries(pass)) log(`${v ? 'PASS' : 'FAIL'} ${k}`)
  ;(window as unknown as { __benchDetail: string }).__benchDetail = lines.join('\n')
}

document.getElementById('detail')!.addEventListener('click', () => void runDetailBench().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('pitch')!.addEventListener('click', () => void runPitch().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('fine')!.addEventListener('click', () => void runFine().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('copy')!.addEventListener('click', () => void navigator.clipboard.writeText(lines.join('\n')))
;(window as unknown as { __runBench: typeof run; __runFine: typeof runFine }).__runBench = run

/** ?auto=live (or run, fine, thermal, tiles, stages, pitch, detail; comma-separated): run on load and POST each report to the bench server. */
async function autoRun(names: string[]): Promise<void> {
  const runs: Record<string, () => Promise<unknown>> = { run, fine: runFine, thermal: runThermal, live: () => runLive(), tiles: runTiles, stages: runStages, pitch: runPitch, detail: runDetailBench }
  for (const name of names) {
    const fn = runs[name]
    if (!fn) {
      log(`?auto: unknown run "${name}" (expected ${Object.keys(runs).join(', ')})`)
      continue
    }
    await nextFrame()
    try {
      await fn()
    } catch (e) {
      log(`ERROR ${String(e)}`)
    }
    await fetch('/__bench-report', { method: 'POST', body: `[auto=${name}]\n${lines.join('\n')}` }).catch(() => {})
  }
}
const auto = new URLSearchParams(location.search).get('auto')
if (auto) void autoRun(auto.split(',').map((s) => s.trim()).filter(Boolean))
;(window as unknown as { __runFine: typeof runFine }).__runFine = runFine

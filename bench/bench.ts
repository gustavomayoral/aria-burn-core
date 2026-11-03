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
import { decodeSampleBatch, type JobModel, type MachineProfile } from '../src/contract/index.ts'
import {
  CpuPeakTemperatureStep,
  GlOverview,
  GlSim,
  LiveJob,
  SampleStore,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  simulateCpu,
  stitch,
  type GlRunResult,
  type GlThermalResult,
  type SimSetup,
  type StageEnergy,
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
const sim = new GlSim(gl)
const overview = new GlOverview(gl, 2048)

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
 * BURN-33: what one live (network) refresh costs as a streamed job grows.
 * Replays the app's refresh (aria-burn burn.svelte.ts scheduleLive → tick):
 * new batches arrive, the setup is rebuilt on live tiling, then a coarse run
 * at the live head, which reruns the thermal step because the store changed.
 * The app waits max(100 ms, 2 × last refresh) before the next one.
 */
async function runLive(steps = 10, only?: number[]): Promise<void> {
  lines.length = 0
  log('== Live job (BURN-33): cost of one refresh as the stream grows ==')
  log(`user agent: ${navigator.userAgent}`)
  log(`gl renderer: ${sim.caps.renderer}`)
  log(`gl error before: ${gl!.getError()}`)
  const replay = async (label: string, m: MachineProfile, material: MaterialProfile) => {
    log()
    log(`== ${label} ==`)
    const { plan } = storeFor(rasterJob({ x0Mm: 10, y0Mm: 10, widthMm: 100, heightMm: 100, intervalMm: 0.1, feedMmPerMin: 6000, s: 300 }), m)
    const live = new LiveJob(1, 'bench', m, material)
    const n = plan.batches.length
    log(`batches ${n} · job ${plan.durationS.toFixed(0)} s · ${steps} refreshes`)
    log('streamed | samples    | tiles | setup    | thermal   | coarse   | refresh  | next wait')
    let fed = 0
    let lastRefresh = 0
    const refreshes: number[] = []
    for (let i = 1; i <= steps; i++) {
      const upTo = Math.round((n * i) / steps)
      for (; fed < upTo; fed++) live.onBatch(plan.batches[fed]!)
      const t0 = performance.now()
      const setup = live.setup()!
      const t1 = performance.now()
      sim.syncSamples(live.store)
      sim.thermal(live.store, setup)
      sim.sync()
      const t2 = performance.now()
      sim.runCoarse(live.store, setup, live.cutoffS(1, true))
      sim.sync()
      const t3 = performance.now()
      lastRefresh = t3 - t0
      refreshes.push(lastRefresh)
      const pct = `${Math.round((100 * i) / steps)} %`.padStart(8)
      const count = live.store.count.toLocaleString().padStart(10)
      const tiles = String(setup.plan.tiles.length).padStart(5)
      log(`${pct} | ${count} | ${tiles} | ${ms(t1 - t0).padStart(8)} | ${ms(t2 - t1).padStart(9)} | ${ms(t3 - t2).padStart(8)} | ${ms(lastRefresh).padStart(8)} | ${ms(Math.max(100, 2 * lastRefresh)).padStart(8)}`)
      await nextFrame()
    }
    log(`refresh: ${stats(refreshes)} · last ${ms(lastRefresh)} → the app's next refresh waits ${ms(Math.max(100, 2 * lastRefresh))}`)
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
    for (const i of only ?? cases.keys()) await replay(...cases[i]!)
  } catch (err) {
    log(`FAILED: ${String(err)}`)
  }
  log(`gl error: ${gl!.getError()}`)
  ;(window as unknown as { __benchLive: string }).__benchLive = lines.join('\n')
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
document.getElementById('run')!.addEventListener('click', () => void run().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('fine')!.addEventListener('click', () => void runFine().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('copy')!.addEventListener('click', () => void navigator.clipboard.writeText(lines.join('\n')))
;(window as unknown as { __runBench: typeof run; __runFine: typeof runFine }).__runBench = run
;(window as unknown as { __runFine: typeof runFine }).__runFine = runFine

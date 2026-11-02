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
  GlOverview,
  GlSim,
  SampleStore,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  simulateCpu,
  stitch,
  type GlRunResult,
  type SimSetup,
  type StageEnergy,
} from '../src/sim/index.ts'
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
  const cpuArrays = { fluence: cpu.fluence.data, color: cpu.color, verdict: cpu.verdict }
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

document.getElementById('run')!.addEventListener('click', () => void run().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('fine')!.addEventListener('click', () => void runFine().catch((e) => log(`ERROR ${String(e)}`)))
document.getElementById('copy')!.addEventListener('click', () => void navigator.clipboard.writeText(lines.join('\n')))
;(window as unknown as { __runBench: typeof run; __runFine: typeof runFine }).__runBench = run
;(window as unknown as { __runFine: typeof runFine }).__runFine = runFine

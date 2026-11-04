// SPDX-License-Identifier: MIT
// BURN-37: what a coarser job pitch (k × the σ/3 detail pitch) costs against
// the CPU reference at k = 1, on the provisional 10 W diode.
//   pnpm tsx scripts/burn-37-accuracy.ts
// Per material and k: energy at every stage, effective blur width across a
// single line, peak fluence, colour and verdict against the k = 1 run
// box-averaged / centre-sampled onto the coarse cells, and how far verdict
// edges move.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { coarsePitchKernel, decodeSampleBatch, Verdict, type JobModel, type MaterialProfile } from '../src/contract/index.ts'
import { separableKernel, interimSampler, loadMachineProfile, loadMaterialProfile, SampleStore, setupJob, simulateCpu, stitch, type SimSetup } from '../src/sim/index.ts'
import { concatJobs, rasterJob, squareJob } from '../src/sim/test-jobs.ts'

const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../src/profiles/provisional/${name}`, import.meta.url)), 'utf8')
const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
const materials: [string, MaterialProfile][] = [
  ['birch-ply (char, thermal)', loadMaterialProfile(provisional('birch-ply.json'))],
  ['black-cast-acrylic (melt)', loadMaterialProfile(provisional('black-cast-acrylic.json'))],
  ['black-anodized-aluminum (bleach)', loadMaterialProfile(provisional('black-anodized-aluminum.json'))],
]

function storeFor(job: JobModel): SampleStore {
  const plan = interimSampler.plan(job, machine, 1)
  const store = new SampleStore(1)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  return store
}

// A raster fill (striping, line ends), a cut outline (corner scorch) and a lone line (blur width).
const job = concatJobs(
  rasterJob({ x0Mm: 1, y0Mm: 1, widthMm: 3, heightMm: 1.5, intervalMm: 0.08, feedMmPerMin: 3000, s: 600 }),
  squareJob(5, 1, 1.5, 600, 800),
  rasterJob({ x0Mm: 1, y0Mm: 3.5, widthMm: 5, heightMm: 0, intervalMm: 1, feedMmPerMin: 1200, s: 700 }),
)
const store = storeFor(job)
const LINE_Y = 3.5
const KS = [1, 2, 3, 4]

const out: string[] = []
const log = (s: string) => {
  out.push(s)
  console.log(s)
}

/** Second moment (mm) of fluence across the lone line, averaged over columns in its middle. */
function lineSigmaMm(setup: SimSetup, f: Float32Array): { sigma: number; peak: number } {
  const g = setup.grid
  let sum = 0
  let peak = 0
  let n = 0
  for (let x = 0; x < g.width; x++) {
    const xMm = g.originXMm + (x + 0.5) * g.pitchMm
    if (xMm < 2.5 || xMm > 4.5) continue
    let m0 = 0
    let m1 = 0
    let m2 = 0
    for (let y = 0; y < g.height; y++) {
      const yMm = g.originYMm + (y + 0.5) * g.pitchMm
      if (Math.abs(yMm - LINE_Y) > 0.3) continue
      const v = f[y * g.width + x]!
      m0 += v
      m1 += v * yMm
      m2 += v * yMm * yMm
      peak = Math.max(peak, v)
    }
    const mean = m1 / m0
    sum += Math.sqrt(m2 / m0 - mean * mean)
    n++
  }
  return { sigma: sum / n, peak }
}

for (const [name, material] of materials) {
  log(`== ${name} ==`)
  const fine = setupJob(job.burnBounds!, machine, material)
  const fineOut = stitch(simulateCpu(store, fine))
  const fineLine = lineSigmaMm(fine, fineOut.fluence.data)
  const p = fine.grid.pitchMm
  log(`detail pitch ${(p * 1000).toFixed(2)} µm · kernel σ ${(fine.kernel.sigmaUMm * 1000).toFixed(1)} × ${(fine.kernel.sigmaVMm * 1000).toFixed(1)} µm · line σ ${(fineLine.sigma * 1000).toFixed(2)} µm`)
  log('k  pitch µm  energy dep/H/V            line σ µm (Δ)     line peak Δ   peak Δ (box)   fluence err p99 (of peak)  colour Δ p99/max  verdict mismatch  edge shift µm (mean/max)')
  for (const k of KS) {
    // jobPitchMm picks k from a cell budget; here it is forced. The blur at k > 1 is
    // coarsePitchKernel's, as setupJob builds it; UNCOMPENSATED=1 keeps the k = 1 kernel to show what that buys.
    const forced = setupJob(job.burnBounds!, machine, material, { pitchMm: k * p })
    const kernel = process.env.UNCOMPENSATED ? fine.kernel : coarsePitchKernel(fine.kernel, k * p, p)
    const setup: SimSetup = k === 1 ? fine : { ...forced, detailPitchMm: p, separable: separableKernel(kernel, k * p) }
    const run = simulateCpu(store, setup)
    const o = stitch(run)
    const e = run.energy
    const en = [e.depositJ, e.blurHJ, e.blurVJ].map((v) => (v / e.expectedJ).toFixed(4)).join('/')
    const line = lineSigmaMm(setup, o.fluence.data)
    const g = setup.grid
    // Box-average the fine run onto this grid (job lattices nest: offset in fine cells).
    const ox = Math.round((g.originXMm - fine.grid.originXMm) / p)
    const oy = Math.round((g.originYMm - fine.grid.originYMm) / p)
    const errs: number[] = []
    const cdel: number[] = []
    let finePeak = 0
    let boxPeak = 0
    let peak = 0
    let mismatch = 0
    let marked = 0
    const field = material.thermal.kind !== 'none' ? (s: ReturnType<typeof stitch>) => s.dose! : (s: ReturnType<typeof stitch>) => s.fluence.data
    const ff = field(fineOut)
    const cf = field(o)
    for (let i = 0; i < ff.length; i++) finePeak = Math.max(finePeak, ff[i]!)
    for (let y = 0; y < g.height; y++) {
      for (let x = 0; x < g.width; x++) {
        let box = 0
        let cnt = 0
        for (let j = 0; j < k; j++) {
          for (let i = 0; i < k; i++) {
            const fx = ox + x * k + i
            const fy = oy + y * k + j
            if (fx < 0 || fy < 0 || fx >= fine.grid.width || fy >= fine.grid.height) continue
            box += ff[fy * fine.grid.width + fx]!
            cnt++
          }
        }
        if (!cnt) continue
        box /= cnt
        const c = cf[y * g.width + x]!
        boxPeak = Math.max(boxPeak, box)
        peak = Math.max(peak, c)
        if (box > finePeak * 1e-3 || c > finePeak * 1e-3) errs.push(Math.abs(c - box) / finePeak)
        // Centre sample of the fine run for colour and verdict (a coarse cell shows one value).
        const fx = ox + x * k + Math.floor(k / 2)
        const fy = oy + y * k + Math.floor(k / 2)
        if (fx >= fine.grid.width || fy >= fine.grid.height) continue
        const fi = fy * fine.grid.width + fx
        const ci = y * g.width + x
        const fv = fineOut.verdict[fi]!
        const cv = o.verdict[ci]!
        if (fv !== Verdict.Untouched || cv !== Verdict.Untouched) {
          marked++
          if (fv !== cv) mismatch++
          let d = 0
          for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs(fineOut.color[fi * 4 + ch]! - o.color[ci * 4 + ch]!))
          cdel.push(d)
        }
      }
    }
    // Verdict edge shift: for each coarse cell whose verdict differs from the fine centre sample,
    // distance (µm) to the nearest fine cell with the coarse verdict.
    const shifts: number[] = []
    for (let y = 0; y < g.height && k > 1; y++) {
      for (let x = 0; x < g.width; x++) {
        const fx = ox + x * k + Math.floor(k / 2)
        const fy = oy + y * k + Math.floor(k / 2)
        if (fx >= fine.grid.width || fy >= fine.grid.height) continue
        const cv = o.verdict[y * g.width + x]!
        if (fineOut.verdict[fy * fine.grid.width + fx] === cv) continue
        let best = Infinity
        const R = 6 * k
        for (let dy = -R; dy <= R; dy++)
          for (let dx = -R; dx <= R; dx++) {
            const u = fx + dx
            const v = fy + dy
            if (u < 0 || v < 0 || u >= fine.grid.width || v >= fine.grid.height) continue
            if (fineOut.verdict[v * fine.grid.width + u] === cv) best = Math.min(best, Math.hypot(dx, dy) * p * 1000)
          }
        shifts.push(best)
      }
    }
    errs.sort((a, b) => a - b)
    cdel.sort((a, b) => a - b)
    const p99 = (a: number[]) => (a.length ? a[Math.floor(a.length * 0.99)]! : 0)
    const finite = shifts.filter(Number.isFinite)
    const meanShift = finite.length ? finite.reduce((s, v) => s + v, 0) / finite.length : 0
    const maxShift = shifts.length ? Math.max(...shifts) : 0
    log(
      [
        String(k).padEnd(2),
        (g.pitchMm * 1000).toFixed(1).padStart(8),
        `  ${en}`.padEnd(26),
        `${(line.sigma * 1000).toFixed(2)} (${(((line.sigma - fineLine.sigma) / fineLine.sigma) * 100).toFixed(1)}%)`.padEnd(18),
        `${(((line.peak - fineLine.peak) / fineLine.peak) * 100).toFixed(1)}%`.padEnd(13),
        `${(((peak - boxPeak) / boxPeak) * 100).toFixed(1)}%`.padEnd(14),
        `${(p99(errs) * 100).toFixed(2)}%`.padEnd(26),
        `${p99(cdel)}/${cdel.length ? cdel[cdel.length - 1] : 0}`.padEnd(17),
        `${((mismatch / Math.max(1, marked)) * 100).toFixed(2)}% of ${marked}`.padEnd(17),
        `${meanShift.toFixed(1)}/${Number.isFinite(maxShift) ? maxShift.toFixed(1) : '>' + (6 * k * p * 1000).toFixed(0)}`,
      ].join(' '),
    )
  }
}

const target = process.argv[2]
if (target) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(target, out.join('\n') + '\n')
}

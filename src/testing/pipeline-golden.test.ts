// SPDX-License-Identifier: MIT
// Golden renders of the CPU reference pipeline (COD-264): one small job
// (raster fill + square outline) on each provisional material, colour and
// depth. Re-bless with `pnpm golden:update` after an intended model change.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSampleBatch } from '../contract/index.ts'
import {
  SampleStore,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  simulateCpu,
  stitch,
} from '../sim/index.ts'
import { concatJobs, rasterJob, squareJob } from '../sim/test-jobs.ts'
import { compareFieldGolden, compareRgbaGolden } from './golden.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
const job = concatJobs(
  rasterJob({ x0Mm: 0.3, y0Mm: 0.3, widthMm: 1.4, heightMm: 0.6, intervalMm: 0.05, feedMmPerMin: 3000, s: 300 }),
  squareJob(0.2, 0.2, 2, 600, 900, 'm3'),
)
const plan = interimSampler.plan(job, machine, 1)
const store = new SampleStore(1)
for (const b of plan.batches) store.append(decodeSampleBatch(b))

/** Outputs are row 0 = min Y; goldens are top-down. */
function flipRows<T extends Uint8ClampedArray | Float32Array>(data: T, width: number, height: number, channels: number): T {
  const out = new (data.constructor as new (n: number) => T)(data.length)
  const row = width * channels
  for (let y = 0; y < height; y++) out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  return out
}

describe.each([
  ['birch-ply.json', 'pipeline-char'],
  ['black-cast-acrylic.json', 'pipeline-melt'],
  ['black-anodized-aluminum.json', 'pipeline-bleach'],
])('%s', (file, name) => {
  const material = loadMaterialProfile(provisional(file))
  const setup = setupJob(job.burnBounds!, machine, material)
  const out = stitch(simulateCpu(store, setup))
  const { width, height } = setup.grid

  it('colour matches the golden', () => {
    const r = compareRgbaGolden(`${name}-color`, { width, height, data: flipRows(out.color, width, height, 4) })
    expect(r.pass, r.message).toBe(true)
  })

  it('depth matches the golden', () => {
    const max = out.depthMm.reduce((m, v) => Math.max(m, v), 1e-6)
    const r = compareFieldGolden(`${name}-depth`, { width, height, data: flipRows(out.depthMm, width, height, 1), max })
    expect(r.pass, r.message).toBe(true)
  })
})

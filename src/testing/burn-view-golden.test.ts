// SPDX-License-Identifier: MIT
// Burn view (COD-259): golden renders of the CPU reference shading over the
// pipeline goldens' job, plus the rules it is built from. Re-bless with
// `pnpm golden:update` after an intended change to burn-view.ts (and mirror it
// in gl/burn-view-shaders.ts).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Verdict, decodeSampleBatch } from '../contract/index.ts'
import {
  SampleStore,
  baseGain,
  burnViewParams,
  fireSpots,
  interimSampler,
  loadMachineProfile,
  loadMaterialProfile,
  coverOf,
  regionOf,
  reliefShade,
  setupJob,
  shadeBurnView,
  simulateCpu,
  stitch,
  type BurnViewLayer,
} from '../sim/index.ts'
import { concatJobs, rasterJob, squareJob } from '../sim/test-jobs.ts'
import { compareRgbaGolden } from './golden.ts'

const provisional = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')

const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
// The pipeline goldens' job: a raster fill (striping) and a square outline (corner scorch).
const job = concatJobs(
  rasterJob({ x0Mm: 0.3, y0Mm: 0.3, widthMm: 1.4, heightMm: 0.6, intervalMm: 0.05, feedMmPerMin: 3000, s: 300 }),
  squareJob(0.2, 0.2, 2, 600, 900, 'm3'),
)
const plan = interimSampler.plan(job, machine, 1)
const store = new SampleStore(1)
for (const b of plan.batches) store.append(decodeSampleBatch(b))

function flipRows(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length)
  const row = width * 4
  for (let y = 0; y < height; y++) out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  return out
}

function layerFor(file: string): { layer: BurnViewLayer; material: ReturnType<typeof loadMaterialProfile> } {
  const material = loadMaterialProfile(provisional(file))
  const setup = setupJob(job.burnBounds!, machine, material)
  const out = stitch(simulateCpu(store, setup))
  const { grid } = setup
  return {
    material,
    layer: {
      width: grid.width,
      height: grid.height,
      originXMm: grid.originXMm,
      originYMm: grid.originYMm,
      texelMm: grid.pitchMm,
      color: out.color,
      quantity: out.dose ?? out.fluence.data,
      depthMm: out.depthMm,
      verdict: out.verdict,
    },
  }
}

describe.each([
  ['birch-ply.json', 'burn-view-char'],
  ['black-cast-acrylic.json', 'burn-view-melt'],
  ['black-anodized-aluminum.json', 'burn-view-bleach'],
])('%s', (file, name) => {
  const { layer, material } = layerFor(file)
  const params = burnViewParams(material)

  it('shaded view matches the golden', () => {
    const rgba = shadeBurnView(layer, params, { relief: true, halo: true, overlay: false })
    const r = compareRgbaGolden(name, { width: layer.width, height: layer.height, data: flipRows(rgba, layer.width, layer.height) })
    expect(r.pass, r.message).toBe(true)
  })

  it('verdict overlay matches the golden', () => {
    const rgba = shadeBurnView(layer, params, { relief: true, halo: true, overlay: true })
    const r = compareRgbaGolden(`${name}-overlay`, { width: layer.width, height: layer.height, data: flipRows(rgba, layer.width, layer.height) })
    expect(r.pass, r.message).toBe(true)
  })

  it('unburned cells show the textured base colour', () => {
    const rgba = shadeBurnView(layer, params, { relief: true, halo: false, overlay: false })
    // Corner texel: nothing reaches it.
    expect(layer.quantity[0]).toBe(0)
    const g = baseGain(params.texture, layer.originXMm + 0.5 * layer.texelMm, layer.originYMm + 0.5 * layer.texelMm)
    for (let c = 0; c < 3; c++) {
      const want = layer.color[c]! / 255 + params.base[c]! * (g - 1)
      expect(Math.abs(rgba[c]! - Math.round(Math.min(1, Math.max(0, want)) * 255))).toBeLessThanOrEqual(1)
    }
  })
})

describe('burn view rules', () => {
  it('relief is neutral on flat ground and lit on walls facing the upper left', () => {
    expect(reliefShade(0, 0)).toBeCloseTo(1, 12)
    // Depth falling toward the upper left = a wall facing up-left: lit.
    expect(reliefShade(-0.5, 0.5)).toBeGreaterThan(1)
    expect(reliefShade(0.5, -0.5)).toBeLessThan(1)
  })

  it('the wood grain varies; the bleach texture is subtle', () => {
    const wood = Array.from({ length: 200 }, (_, i) => baseGain('wood', 3.1, i * 0.05))
    expect(Math.max(...wood) - Math.min(...wood)).toBeGreaterThan(0.08)
    const cast = Array.from({ length: 200 }, (_, i) => baseGain('cast', i * 0.5, i * 0.3))
    expect(Math.max(...cast) - Math.min(...cast)).toBeLessThan(0.04)
  })

  it('regions follow the commonest bucket and never smooth fire risk away', () => {
    expect(regionOf([0.1, 0.6, 0.2, 0])).toBe(Verdict.InRange)
    expect(regionOf([0.1, 0.3, 0.3, 0])).toBe(Verdict.Over)
    expect(regionOf([0.1, 0.6, 0.2, 0.001])).toBe(Verdict.FireRisk)
    // A few stray marks on untouched ground stay untouched.
    expect(regionOf([0.1, 0.05, 0, 0])).toBe(Verdict.Untouched)
    expect(coverOf(Verdict.Over)).toEqual([0, 0, 1, 0])
    expect(coverOf(Verdict.Untouched)).toEqual([0, 0, 0, 0])
  })

  it('finds fire-risk patches, largest first, in mm', () => {
    const w = 20
    const v = new Uint8Array(w * w)
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) v[y * w + x] = Verdict.FireRisk // 16 cells
    v[15 * w + 15] = Verdict.FireRisk
    const spots = fireSpots(v, w, w, 10, 20, 0.5)
    expect(spots).toHaveLength(2)
    expect(spots[0]!.areaMm2).toBeCloseTo(4, 9)
    expect(spots[0]!.xMm).toBeCloseTo(10 + 4 * 0.5, 9)
    expect(spots[0]!.yMm).toBeCloseTo(20 + 4 * 0.5, 9)
    expect(spots[1]!.areaMm2).toBeCloseTo(0.25, 9)
  })
})

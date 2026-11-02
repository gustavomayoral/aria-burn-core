// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { TSchema } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { ARTIFACT_PATHS, contractArtifacts, type SampleBatchFixture } from './artifacts.ts'
import {
  COARSE_MAX_CELLS,
  ChannelEvent,
  Command,
  JobModel,
  MachineProfile,
  MaterialProfile,
  SAMPLE_STRIDE_BYTES,
  TILE_MAX_CELLS,
  Verdict,
  beamOn,
  buildContractSchema,
  checkMachineProfile,
  checkMaterialProfile,
  classifyFluence,
  coarseGrid,
  coarseKernel,
  decodeSampleBatch,
  encodeSampleBatch,
  gridPitchMm,
  kernelSigma,
  opticalPowerW,
  planJobGrid,
  planTiles,
  readSample,
  scrubCutoffS,
  validate,
  type MachineProfile as MachineProfileT,
  type MaterialProfile as MaterialProfileT,
} from './index.ts'

const fixture = <T = unknown>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')) as T

const FIXTURES: [string, TSchema, string][] = [
  ['job-model.json', JobModel, 'JobModel'],
  ['machine-profile.json', MachineProfile, 'MachineProfile'],
  ['material-char.json', MaterialProfile, 'MaterialProfile'],
  ['material-melt.json', MaterialProfile, 'MaterialProfile'],
  ['material-bleach.json', MaterialProfile, 'MaterialProfile'],
  ['status-event.json', ChannelEvent, 'ChannelEvent'],
  ['job-loaded-event.json', ChannelEvent, 'ChannelEvent'],
  ['plan-done-event.json', ChannelEvent, 'ChannelEvent'],
  ['command-plan-start.json', Command, 'Command'],
]

const machine = fixture<MachineProfileT>('machine-profile.json')
const wood = fixture<MaterialProfileT>('material-char.json')

describe('generated artefacts', () => {
  it('are up to date (run `pnpm contract:export`)', () => {
    for (const { path, content } of contractArtifacts()) {
      expect(Buffer.compare(readFileSync(path), content), path).toBe(0)
    }
  })
})

describe('fixtures', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addFormat('uint32', true)
  ajv.addSchema(buildContractSchema())
  const bundle = (id: string) => ajv.getSchema(`${buildContractSchema().$id as string}#/$defs/${id}`)!

  it.each(FIXTURES)('%s validates against the TypeBox schema', (name, schema) => {
    expect(validate(schema, fixture(name))).toEqual([])
  })

  it.each(FIXTURES)('%s validates against the exported JSON Schema', (name, _schema, def) => {
    const check = bundle(def)
    const ok = check(fixture(name))
    expect(check.errors ?? [], name).toEqual([])
    expect(ok).toBe(true)
  })

  it('rejects unknown fields and wrong tags', () => {
    expect(validate(JobModel, { ...fixture<object>('job-model.json'), extra: 1 })).not.toEqual([])
    expect(validate(Command, { type: 'plan.start' })).not.toEqual([])
    expect(bundle('Command')({ type: 'nope', jobId: 1 })).toBe(false)
  })

  it('accepts calibrated provenance with a fit timestamp', () => {
    const calibrated = { ...wood, provenance: { source: 'calibrated', fittedAt: '2026-11-01T12:00:00Z', meanDeltaE: 2.1 } }
    expect(validate(MaterialProfile, calibrated)).toEqual([])
    expect(bundle('MaterialProfile')(calibrated)).toBe(true)
    expect(validate(MaterialProfile, { ...calibrated, provenance: { source: 'calibrated', fittedAt: 'yesterday' } })).not.toEqual([])
  })

  it('profiles pass the ordering checks', () => {
    expect(checkMachineProfile(machine)).toEqual([])
    for (const name of ['material-char.json', 'material-melt.json', 'material-bleach.json'])
      expect(checkMaterialProfile(fixture(name)), name).toEqual([])
  })
})

describe('sample batch binary layout', () => {
  const json = fixture<SampleBatchFixture>('sample-batch.json')
  const bin = readFileSync(ARTIFACT_PATHS.sampleBatchBin)

  it('decodes the committed .bin to the .json fixture', () => {
    const buffer = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
    const batch = decodeSampleBatch(buffer)
    expect(batch.sampleCount).toBe(json.samples.length)
    expect({ sequence: batch.sequence, t0S: batch.t0S, jobId: batch.jobId, last: batch.last }).toEqual(json.header)
    expect(json.samples.map((_, i) => readSample(batch, i))).toEqual(json.samples)
  })

  it('has a 28-byte stride and rejects bad input', () => {
    expect(SAMPLE_STRIDE_BYTES).toBe(28)
    const good = encodeSampleBatch(json.header, json.samples)
    const bad = good.slice(0)
    new DataView(bad).setUint32(0, 0, true)
    expect(() => decodeSampleBatch(bad)).toThrow(/magic/)
    expect(() => decodeSampleBatch(good.slice(0, good.byteLength - 4))).toThrow(/bytes/)
  })
})

describe('power', () => {
  it('applies the S → power curve and M4 speed scaling', () => {
    expect(opticalPowerW(machine, 1000, 'm3', 0, 1200)).toBeCloseTo(5)
    expect(opticalPowerW(machine, 1000, 'm4', 600, 1200)).toBeCloseTo(5 * (0.15 + (0.3 / 0.8) * 0.85))
    expect(opticalPowerW(machine, 30, 'm3', 1200, 1200)).toBe(0)
    expect(opticalPowerW(machine, 1000, 'off', 1200, 1200)).toBe(0)
  })

  it('beam is on only for g1 with laser on and S > 0', () => {
    const job = fixture<{ moves: Parameters<typeof beamOn>[0][] }>('job-model.json')
    expect(job.moves.map(beamOn)).toEqual([false, true, true, true, true, true, false])
  })
})

describe('deposit, tiling, scrub rules', () => {
  const kernel = kernelSigma(machine.spot, wood.sigmaHeatMm)
  const pitch = gridPitchMm(machine.spot)

  it('pitch is minor sigma / 3 and kernel adds heat in quadrature', () => {
    expect(pitch).toBeCloseTo(0.02 / 3)
    expect(kernel.sigmaUMm).toBeCloseTo(Math.hypot(0.0375, 0.05))
    expect(kernel.sigmaVMm).toBeCloseTo(Math.hypot(0.02, 0.05))
  })

  it('a small job is one tile', () => {
    const grid = planJobGrid({ minXMm: 10, minYMm: 10, maxXMm: 20, maxYMm: 25 }, pitch, kernel)
    const plan = planTiles(grid, kernel)
    expect(plan.tiles).toHaveLength(1)
    expect(grid.width * pitch).toBeGreaterThan(10)
  })

  it('a large job tiles within the cell budget and cores partition the grid', () => {
    const grid = planJobGrid({ minXMm: 0, minYMm: 0, maxXMm: 120, maxYMm: 70 }, pitch, kernel)
    const plan = planTiles(grid, kernel)
    expect(plan.cols * plan.rows).toBe(plan.tiles.length)
    expect(plan.tiles.length).toBeGreaterThan(1)
    let covered = 0
    for (const t of plan.tiles) {
      expect(t.padded.width).toBeLessThanOrEqual(TILE_MAX_CELLS)
      expect(t.padded.height).toBeLessThanOrEqual(TILE_MAX_CELLS)
      covered += t.core.width * t.core.height
    }
    expect(covered).toBe(grid.width * grid.height)
  })

  it('scrub maps progress linearly and coarse grids stay small and resolved', () => {
    expect(scrubCutoffS(0.5, 10)).toBe(5)
    expect(scrubCutoffS(2, 10)).toBe(10)
    const grid = planJobGrid({ minXMm: 0, minYMm: 0, maxXMm: 120, maxYMm: 70 }, pitch, kernel)
    const coarse = coarseGrid(grid)
    expect(Math.max(coarse.width, coarse.height)).toBeLessThanOrEqual(COARSE_MAX_CELLS)
    const k = coarseKernel(kernel, coarse.pitchMm)
    expect(Math.min(k.sigmaUMm, k.sigmaVMm)).toBeGreaterThanOrEqual(coarse.pitchMm)
  })
})

describe('verdict', () => {
  it('buckets fluence per kind with fire risk first', () => {
    expect(classifyFluence(wood, 0)).toBe(Verdict.Untouched)
    expect(classifyFluence(wood, 0.2)).toBe(Verdict.Under)
    expect(classifyFluence(wood, 1)).toBe(Verdict.InRange)
    expect(classifyFluence(wood, 5)).toBe(Verdict.Over)
    expect(classifyFluence(wood, 12)).toBe(Verdict.FireRisk)
  })
})

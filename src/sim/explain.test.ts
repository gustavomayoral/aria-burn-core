// SPDX-License-Identifier: MIT
// Outcome explanation (BURN-45): contributions use the deposit's own weights,
// so they add up to the cell, and over-burn causes name what pushed it over.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Verdict, decodeSampleBatch, type JobModel, type MaterialProfile } from '../contract/index.ts'
import { CellReader, SampleStore, explainAt, interimSampler, loadMachineProfile, loadMaterialProfile, setupJob, simulateCpu, stitch } from './index.ts'
import { rasterJob, squareJob } from './test-jobs.ts'

const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')
const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
const wood = loadMaterialProfile(provisional('birch-ply.json'))
const woodFluence: MaterialProfile = { ...wood, thermal: { kind: 'none' }, fireRisk: { kind: 'none' } }
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-30)

function readerFor(job: JobModel, material: MaterialProfile) {
  const store = new SampleStore(1)
  for (const b of interimSampler.plan(job, machine, 1).batches) store.append(decodeSampleBatch(b))
  const setup = setupJob(job.burnBounds!, machine, material)
  return { store, setup, reader: new CellReader(store, setup) }
}

describe('cell explanation, M3 square (fluence only)', () => {
  // 2 mm square at 3000 mm/min, M3: the edges are in range, the corners over-burn where the head stops.
  const job = squareJob(1, 1, 2, 3000, 400, 'm3')
  const { store, setup, reader } = readerFor(job, woodFluence)
  const out = stitch(simulateCpu(store, setup))

  it('top contributors sum to the cell fluence, as the grid pipeline deposits it', () => {
    for (const [x, y] of [
      [2, 1],
      [3, 1],
      [3, 3],
      [1.02, 2],
    ] as const) {
      const e = explainAt(reader, store, x, y, Infinity, job)!
      const r = e.readout
      expect(rel(e.fluenceJPerMm2, r.fluenceJPerMm2)).toBeLessThan(1e-6)
      expect(rel(e.fluenceJPerMm2, out.fluence.data[r.cellY * setup.grid.width + r.cellX]!)).toBeLessThan(1e-4)
      const listed = e.moves.reduce((t, m) => t + m.fluenceJPerMm2, 0)
      expect(listed / e.fluenceJPerMm2).toBeGreaterThan(0.99)
      expect(e.listedShare).toBeCloseTo(listed / e.fluenceJPerMm2, 6)
    }
  })

  it('an edge cell: one move at the commanded speed, in range against the start threshold', () => {
    const e = explainAt(reader, store, 2, 1, Infinity, job)!
    expect(e.readout.verdict).toBe(Verdict.InRange)
    expect(e.moves[0]!.line).toBe(2)
    expect(e.moves[0]!.laser).toBe('m3')
    expect(e.moves[0]!.passIndex).toBe(0)
    expect(e.moves[0]!.commandedMmPerMin).toBe(3000)
    expect(e.moves[0]!.actualMmPerMin).toBeGreaterThan(0.8 * 3000)
    expect(e.reason).toMatchObject({ quantity: 'fluence', bound: 'inRange', threshold: wood.response.kind === 'char' ? wood.response.toneStartJPerMm2 : NaN })
    expect(e.causes).toEqual([])
  })

  it('a corner cell over-burns because the head slowed there', () => {
    const e = explainAt(reader, store, 3, 1, Infinity, job)!
    expect(e.readout.verdict).toBe(Verdict.Over)
    expect(e.reason.bound).toBe('over')
    expect(e.moves.map((m) => m.line).sort()).toEqual([2, 3])
    for (const m of e.moves) expect(m.minActualMmPerMin).toBeLessThan(0.1 * 3000)
    expect(e.causes[0]!.kind).toBe('slowdown')
    expect(e.causes[0]!.speedRatio!).toBeLessThan(0.5)
    expect(e.causes[0]!.verdictWithout).toBeLessThan(Verdict.Over)
  })

  it('works without a job model (live job before job.loaded): no commanded fields, no slowdown check', () => {
    const e = explainAt(reader, store, 3, 1, Infinity, null)!
    expect(e.moves[0]!.commandedMmPerMin).toBeNull()
    expect(e.moves[0]!.laser).toBeNull()
    expect(e.causes.some((c) => c.kind === 'slowdown')).toBe(false)
  })

  it('respects the scrub cutoff', () => {
    const e = explainAt(reader, store, 3, 3, 0, job)!
    expect(e.moveCount).toBe(0)
    expect(e.readout.verdict).toBe(Verdict.Untouched)
  })
})

describe('cell explanation, dense M4 fill (thermal)', () => {
  // 0.1 mm line interval at full power: early lines are in range, later ones over-burn on preheat.
  const job = rasterJob({ x0Mm: 0, y0Mm: 0, widthMm: 3, heightMm: 1.5, intervalMm: 0.1, feedMmPerMin: 2000, s: 1000 })
  const { store, reader } = readerFor(job, wood)

  it('dose contributions sum to the readout dose; late lines over-burn from heat build-up', () => {
    const first = explainAt(reader, store, 1.5, 0.05, Infinity, job)!
    const last = explainAt(reader, store, 1.5, 1.45, Infinity, job)!
    for (const e of [first, last]) {
      expect(rel(e.doseJPerMm2!, e.readout.doseJPerMm2!)).toBeLessThan(1e-6)
      expect(rel(e.fluenceJPerMm2, e.readout.fluenceJPerMm2)).toBeLessThan(1e-6)
      expect(e.listedShare).toBeGreaterThan(0.99)
      expect(e.reason.quantity).toBe('dose')
    }
    expect(first.readout.verdict).toBe(Verdict.InRange)
    expect(last.readout.verdict).toBe(Verdict.Over)
    // Same moves, same fluence: the difference is preheat from the lines before.
    expect(rel(last.fluenceJPerMm2, first.fluenceJPerMm2)).toBeLessThan(0.3)
    expect(last.preheatDoseJPerMm2! / last.doseJPerMm2!).toBeGreaterThan(0.4)
    expect(last.causes[0]!.kind).toBe('heat-build-up')
    expect(last.causes[0]!.verdictWithout).toBeLessThan(Verdict.Over)
    expect(last.moves[0]!.laser).toBe('m4')
  })
})

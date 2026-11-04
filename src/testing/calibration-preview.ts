// SPDX-License-Identifier: MIT
// The calibration-pattern preview behind calibration-golden.test.ts, outside
// the test file so calibration-preview.worker.ts can run it off the vitest worker.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { generatePattern, type PatternKind } from '../calibration/index.ts'
import { decodeSampleBatch, type MachineProfile } from '../contract/index.ts'
import { SampleStore, interimSampler, loadMachineProfile, loadMaterialProfile, setupJob, simulateCpu, stitch } from '../sim/index.ts'
import type { RgbaImage } from './golden.ts'

export const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')
export const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
/** Fine enough that 0.06 mm label and corner strokes show at about their real tone. */
const CELL_BUDGET = 2_000_000

function flipRows(data: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length)
  const row = width * 4
  for (let y = 0; y < height; y++) out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row)
  return out
}

export function previewPattern(kind: PatternKind, materialFile: string, pattern: Record<string, unknown> = {}) {
  const material = loadMaterialProfile(provisional(materialFile))
  const p = generatePattern(kind, machine, material, { pattern })
  const setup = setupJob(p.job.burnBounds!, machine, material, { cellBudget: CELL_BUDGET })
  // Sample at the job pitch: a spot whose σ ÷ 3 is the coarse pitch, for the sampler only.
  const s = (setup.grid.pitchMm * 3) / 1
  const samplerMachine: MachineProfile = { ...machine, spot: { ...machine.spot, sigmaXMm: s, sigmaYMm: s } }
  const plan = interimSampler.plan(p.job, samplerMachine, 1)
  const store = new SampleStore(1)
  for (const b of plan.batches) store.append(decodeSampleBatch(b))
  const out = stitch(simulateCpu(store, setup))
  return { pattern: p, setup, out }
}

/** The preview's color image, top row first, as the golden stores it. */
export function previewImage(kind: PatternKind, materialFile: string, pattern: Record<string, unknown> = {}): RgbaImage {
  const { setup, out } = previewPattern(kind, materialFile, pattern)
  const { width, height } = setup.grid
  return { width, height, data: flipRows(out.color, width, height) }
}

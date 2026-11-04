// SPDX-License-Identifier: MIT
// Golden previews of the calibration patterns (BURN-32) on the provisional
// 10 W diode, simulated by the CPU reference over the whole print: every
// pattern at its default size on anodized aluminium (no thermal model), and a
// 3 × 3 grid on wood through the thermal step, which costs ~30 s per job on the
// CPU whatever its size (thermal grid × time bins). Re-bless with
// `pnpm golden:update` after an intended change to a pattern or the model.
//
// The whole print at detail pitch (spot σ ÷ 3 = 5 µm) is ~10⁸ cells, so these
// run at the job cell budget's coarse pitch, and the sampler steps at that
// pitch too (its σ ÷ 3 step only matters at detail resolution). The app
// previews the same G-code through the Rust parser and GRBL planner.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PATTERN_KINDS, generatePattern, type PatternKind } from '../calibration/index.ts'
import { decodeSampleBatch, type MachineProfile } from '../contract/index.ts'
import { SampleStore, interimSampler, loadMachineProfile, loadMaterialProfile, setupJob, simulateCpu, stitch } from '../sim/index.ts'
import { compareRgbaGolden } from './golden.ts'

const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')
const machine = loadMachineProfile(provisional('machine-10w-diode.json'))
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

const SMALL_GRID = { powersPct: [20, 60, 100], cellMm: 3 }

describe.each([
  ...PATTERN_KINDS.map((k) => [k, 'black-anodized-aluminum.json', `pattern-${k}`, {}] as const),
  ['grid', 'birch-ply.json', 'pattern-grid-small-birch', SMALL_GRID] as const,
])('%s on %s', (kind, file, name, options) => {
  it('previews like the golden', () => {
    const material = loadMaterialProfile(provisional(file))
    const feeds = generatePattern('grid', machine, material).options.feedsMmPerMin as number[]
    const pattern = options === SMALL_GRID ? { ...SMALL_GRID, feedsMmPerMin: [feeds[0]!, feeds[2]!, feeds[5]!] } : options
    const { setup, out } = previewPattern(kind, file, pattern)
    const { width, height } = setup.grid
    const r = compareRgbaGolden(name, { width, height, data: flipRows(out.color, width, height) })
    expect(r.pass, r.message).toBe(true)
  }, 180_000) // the small birch grid takes ~77 s alone on Iris Xe laptops
})

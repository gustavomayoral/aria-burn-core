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
//
// The birch grid runs in a worker thread (calibration-preview.worker.ts): its
// thermal step is over a minute of synchronous CPU, longer than vitest's worker
// waits for an RPC reply before reporting an unhandled error.

import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { PATTERN_KINDS, generatePattern, type PatternKind } from '../calibration/index.ts'
import { loadMaterialProfile } from '../sim/index.ts'
import { machine, previewImage, provisional } from './calibration-preview.ts'
import { compareRgbaGolden, type RgbaImage } from './golden.ts'

function previewInWorker(kind: PatternKind, materialFile: string, pattern: Record<string, unknown>): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./calibration-preview.worker.ts', import.meta.url), {
      workerData: { kind, materialFile, pattern },
      execArgv: ['--import', 'tsx'],
    })
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', (code) => reject(new Error(`preview worker exited with ${code} before posting an image`)))
  })
}

const SMALL_GRID = { powersPct: [20, 60, 100], cellMm: 3 }

describe.each([
  ...PATTERN_KINDS.map((k) => [k, 'black-anodized-aluminum.json', `pattern-${k}`, {}] as const),
  ['grid', 'birch-ply.json', 'pattern-grid-small-birch', SMALL_GRID] as const,
])('%s on %s', (kind, file, name, options) => {
  it('previews like the golden', async () => {
    const material = loadMaterialProfile(provisional(file))
    const feeds = generatePattern('grid', machine, material).options.feedsMmPerMin as number[]
    const small = options === SMALL_GRID
    const pattern = small ? { ...SMALL_GRID, feedsMmPerMin: [feeds[0]!, feeds[2]!, feeds[5]!] } : options
    const image = small ? await previewInWorker(kind, file, pattern) : previewImage(kind, file, pattern)
    const r = compareRgbaGolden(name, image)
    expect(r.pass, r.message).toBe(true)
  }, 180_000) // the small birch grid takes ~77 s alone and ~93 s in the full suite on Iris Xe laptops
})

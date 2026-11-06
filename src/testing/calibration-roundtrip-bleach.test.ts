// SPDX-License-Identifier: MIT
// Photo-fit round trip (BURN-15), bleach kind: a grid simulated from known
// parameters, photographed synthetically under three sets of conditions,
// detected, colour-corrected and fitted; every fitted field must be within its
// stated tolerance (calibration-roundtrip.ts TOLERANCES) of the truth. Each
// round trip runs in a worker thread (calibration-roundtrip.worker.ts).

import { describe, expect, it } from 'vitest'
import { interpolateCurve } from '../contract/index.ts'
import { CONDITIONS, MAX_MEAN_DELTA_E, machine, roundTripInWorker } from './calibration-roundtrip.ts'

describe.concurrent('bleach round trip', () => {
  it.each(Object.keys(CONDITIONS))('%s photo: recovers the true parameters within tolerance', async (condition) => {
    const out = await roundTripInWorker({ file: 'black-anodized-aluminum.json', condition })
    const failed = out.rows.filter((r) => !r.pass).map((r) => `${r.name}: true ${r.truth}, fitted ${r.fitted} (${r.error}, tolerance ${r.tolerance})`)
    expect(failed, failed.join('\n')).toEqual([])
    expect(out.meanDeltaE).toBeLessThan(MAX_MEAN_DELTA_E)
  }, 240_000)
})

describe('S → power curve from the grid', () => {
  // The module delivers less than its nominal curve at low S; the grid's fast rows keep the S max column on the ramp.
  const trueCurve = [{ s: 0, power: 0 }, { s: 0.05, power: 0 }, { s: 0.1, power: 0.02 }, { s: 0.2, power: 0.1 }, { s: 0.5, power: 0.45 }, { s: 1, power: 1 }]

  it('recovers the power at each constrained step within 2 %, and the thresholds within 2 %', async () => {
    const out = await roundTripInWorker({ file: 'black-anodized-aluminum.json', condition: 'mild', fitPowerCurve: true, trueCurve, grid: { feedsMmPerMin: [10000, 8000, 6400, 5000, 4000, 3000] } })
    const f = out.powerFactors!
    expect(f.find((x) => x.anchor)!.sFraction).toBe(1)
    const constrained = f.filter((x) => x.constrained && !x.anchor)
    expect(constrained.length).toBeGreaterThanOrEqual(4)
    for (const x of constrained) {
      const want = interpolateCurve(trueCurve, x.sFraction) / interpolateCurve(machine.powerCurve, x.sFraction)
      expect(Math.abs(x.factor / want - 1), `S ${x.sFraction}`).toBeLessThan(0.02)
    }
    const r = out.material.response
    const tr = out.truth.response
    if (r.kind !== 'bleach' || tr.kind !== 'bleach') throw new Error('bleach')
    expect(Math.abs(r.markStartJPerMm2 / tr.markStartJPerMm2 - 1)).toBeLessThan(0.02)
    expect(Math.abs(r.markFullJPerMm2 / tr.markFullJPerMm2 - 1)).toBeLessThan(0.02)
  }, 240_000)
})

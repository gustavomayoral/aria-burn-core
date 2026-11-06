// SPDX-License-Identifier: MIT
// Photo-fit round trip (BURN-15), melt kind: a grid simulated from known
// parameters, photographed synthetically under three sets of conditions,
// detected, colour-corrected and fitted; every fitted field must be within its
// stated tolerance (calibration-roundtrip.ts TOLERANCES) of the truth. Each
// round trip runs in a worker thread (calibration-roundtrip.worker.ts).

import { describe, expect, it } from 'vitest'
import { CONDITIONS, MAX_MEAN_DELTA_E, roundTripInWorker } from './calibration-roundtrip.ts'

describe.concurrent('melt round trip', () => {
  it.each(Object.keys(CONDITIONS))('%s photo: recovers the true parameters within tolerance', async (condition) => {
    const out = await roundTripInWorker({ file: 'black-cast-acrylic.json', condition })
    const failed = out.rows.filter((r) => !r.pass).map((r) => `${r.name}: true ${r.truth}, fitted ${r.fitted} (${r.error}, tolerance ${r.tolerance})`)
    expect(failed, failed.join('\n')).toEqual([])
    expect(out.meanDeltaE).toBeLessThan(MAX_MEAN_DELTA_E)
  }, 240_000)
})

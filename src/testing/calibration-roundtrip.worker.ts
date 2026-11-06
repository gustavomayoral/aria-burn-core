// SPDX-License-Identifier: MIT
// Runs one photo-fit round trip in a worker thread and posts the checked rows
// back: the char kind's fit is ~40 s of synchronous CPU, and vitest reports a
// worker that can't answer its RPC that long as an unhandled error.

import { parentPort, workerData } from 'node:worker_threads'
import { CONDITIONS, check, machine, makeTruth, roundTrip, type RoundTripJob } from './calibration-roundtrip.ts'

const job = workerData as RoundTripJob
const trueMachine = job.trueCurve ? { ...machine, powerCurve: job.trueCurve } : undefined
const truth = makeTruth(job.file, { ...(trueMachine ? { trueMachine } : {}), ...(job.grid ? { grid: job.grid } : {}) })
const rt = roundTrip(truth, CONDITIONS[job.condition]!, { ...(job.fitPowerCurve ? { fitPowerCurve: true } : {}), ...(trueMachine ? { trueMachine } : {}) })
parentPort!.postMessage({
  rows: check(truth, rt),
  meanDeltaE: rt.fit.meanDeltaE,
  maxDeltaE: rt.fit.maxDeltaE,
  powerFactors: rt.fit.powerFactors,
  material: rt.fit.material,
  truth: truth.truth,
  warnings: rt.analysis.warnings,
  patchDeltaE: rt.analysis.correction.meanPatchDeltaE,
})

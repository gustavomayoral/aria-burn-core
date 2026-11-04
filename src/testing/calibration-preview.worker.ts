// SPDX-License-Identifier: MIT
// Runs one previewImage in a worker thread and posts the image back. A thermal
// preview is over a minute of synchronous CPU, and vitest reports a worker that
// can't answer its RPC for that long as an unhandled error.

import { parentPort, workerData } from 'node:worker_threads'
import type { PatternKind } from '../calibration/index.ts'
import { previewImage } from './calibration-preview.ts'

const { kind, materialFile, pattern } = workerData as { kind: PatternKind; materialFile: string; pattern: Record<string, unknown> }
const image = previewImage(kind, materialFile, pattern)
parentPort!.postMessage(image, [image.data.buffer as ArrayBuffer])

// Generated artefacts, computed in one place so the export script and the
// drift test agree byte for byte.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildContractSchema } from './registry.ts'
import { SAMPLE_BATCH_LAYOUT, encodeSampleBatch, type MotionSample, type SampleBatchHeader } from './samples.ts'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export const ARTIFACT_PATHS = {
  schema: here('./schema/contract.schema.json'),
  layout: here('./schema/sample-batch-layout.json'),
  sampleBatchJson: here('./fixtures/sample-batch.json'),
  sampleBatchBin: here('./fixtures/sample-batch.bin'),
} as const

export interface SampleBatchFixture {
  header: Omit<SampleBatchHeader, 'sampleCount'>
  samples: MotionSample[]
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

export function contractArtifacts(): { path: string; content: Buffer }[] {
  const fixture = JSON.parse(readFileSync(ARTIFACT_PATHS.sampleBatchJson, 'utf8')) as SampleBatchFixture
  return [
    { path: ARTIFACT_PATHS.schema, content: json(buildContractSchema()) },
    { path: ARTIFACT_PATHS.layout, content: json(SAMPLE_BATCH_LAYOUT) },
    { path: ARTIFACT_PATHS.sampleBatchBin, content: Buffer.from(encodeSampleBatch(fixture.header, fixture.samples)) },
  ]
}

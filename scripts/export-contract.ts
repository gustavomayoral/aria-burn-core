// Writes the generated contract artefacts the Rust side consumes:
//   src/contract/schema/contract.schema.json   (JSON Schema bundle for typify)
//   src/contract/schema/sample-batch-layout.json (binary layout constants)
//   src/contract/fixtures/sample-batch.bin       (encoded from sample-batch.json)

import { readFileSync, writeFileSync } from 'node:fs'
import { contractArtifacts } from '../src/contract/artifacts.ts'

const check = process.argv.includes('--check')
let stale = 0
for (const { path, content } of contractArtifacts()) {
  const current = (() => {
    try {
      return readFileSync(path)
    } catch {
      return undefined
    }
  })()
  if (current && Buffer.compare(current, content) === 0) continue
  if (check) {
    console.error(`stale: ${path}`)
    stale++
  } else {
    writeFileSync(path, content)
    console.log(`wrote ${path}`)
  }
}
if (stale) {
  console.error('Run `pnpm contract:export` and commit the result.')
  process.exit(1)
}

// SPDX-License-Identifier: MIT
// Re-blesses the golden images: runs the golden tests with UPDATE_GOLDEN=1
// (a script rather than an inline env var so it also works on Windows).
import { spawnSync } from 'node:child_process'

const r = spawnSync('pnpm', ['exec', 'vitest', 'run', 'src/testing'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, UPDATE_GOLDEN: '1' },
})
process.exit(r.status ?? 1)

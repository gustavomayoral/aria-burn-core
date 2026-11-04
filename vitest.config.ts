import { defineConfig } from 'vitest/config'

// The sim, thermal and calibration tests are CPU-bound. With vitest's default (logical CPUs − 1
// workers) a 4-core / 8-thread Iris Xe laptop runs them ~3× slower than alone and they blow
// their timeouts. Even 4 workers (one per physical core) left several over; 2 keeps them inside.
export default defineConfig({
  test: {
    maxWorkers: 2,
  },
})

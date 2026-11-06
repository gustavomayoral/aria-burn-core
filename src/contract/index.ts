// SPDX-License-Identifier: MIT
// v1 simulation contract (COD-260).
//
// Shared across the Rust ↔ webview boundary (TypeBox → JSON Schema → typify):
//   common, job, machine, catalog, material, messages; plus the binary sample layout in samples.
// Shared later (BURN-55 project file), not yet in the bundle: layers (SVG import layer settings).
// Core-internal, plain TS, not shared: deposit, tiling, outputs, scrub, live, thermal.

export * from './common.ts'
export * from './job.ts'
export * from './machine.ts'
export * from './catalog.ts'
export * from './material.ts'
export * from './messages.ts'
export * from './samples.ts'
export * from './deposit.ts'
export * from './tiling.ts'
export * from './outputs.ts'
export * from './scrub.ts'
export * from './live.ts'
export * from './thermal.ts'
export * from './layers.ts'
export * from './registry.ts'

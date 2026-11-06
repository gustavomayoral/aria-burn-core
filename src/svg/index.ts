// SPDX-License-Identifier: MIT
// SVG import (feature BURN-49): read an SVG into mm geometry and LightBurn-style
// colour layers (BURN-50), place it on the bed and make Line mode moves as
// G-code + JobModel (BURN-51) and Fill scan lines (BURN-52). Layer settings
// live in the contract (layers.ts).

export * from './read.ts'
export * from './placement.ts'
export * from './job.ts'
export * from './fill.ts'
export * from './palette.ts'
export * from './xml.ts'
export * from './matrix.ts'
export * from './path.ts'
export * from './units.ts'
export { parseColor, resolvePaint, type Paint } from './style.ts'
export { LayerMode, LayerSettings, FillSettings, defaultLayerSettings } from '../contract/layers.ts'

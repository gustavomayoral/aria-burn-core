// SPDX-License-Identifier: MIT
// SVG import (BURN-50, feature BURN-49): read an SVG into mm geometry and
// LightBurn-style colour layers. Moves and G-code from the layers are BURN-51
// (line) and BURN-52 (fill); layer settings live in the contract (layers.ts).

export * from './read.ts'
export * from './palette.ts'
export * from './xml.ts'
export * from './matrix.ts'
export * from './path.ts'
export * from './units.ts'
export { parseColor, resolvePaint, type Paint } from './style.ts'
export { LayerMode, LayerSettings, FillSettings, defaultLayerSettings } from '../contract/layers.ts'

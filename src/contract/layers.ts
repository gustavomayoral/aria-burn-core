// SPDX-License-Identifier: MIT
// SVG import layer settings (BURN-50, feature BURN-49).
//
// One per colour layer of an imported SVG, as LightBurn sets up its cut layers.
// TypeBox, so they validate inside the project file (BURN-55, project.ts).
// The webview reads that file, so they stay out of ROOT_SCHEMAS and the Rust bundle.
//
// Power: min power is stored and shown for parity with LightBurn, but the
// simulation uses max power only. GRBL M4 already scales power with speed, and
// LightBurn mostly ignores min power for GRBL vector jobs.

import { Type, type Static } from '@sinclair/typebox'
import { NonNegative, Positive, named } from './common.ts'

export const LayerMode = named(
  'LayerMode',
  Type.Union([Type.Literal('line'), Type.Literal('fill')], {
    description:
      'line follows the paths; fill scans closed shapes back and forth. offsetFill (concentric) is reserved for BURN-57.',
  }),
)
export type LayerMode = Static<typeof LayerMode>

const Percent = (description: string) => Type.Number({ description: `${description} (%)`, minimum: 0, maximum: 100 })

export const FillSettings = named(
  'FillSettings',
  Type.Object(
    {
      intervalMm: Positive('Distance between scan lines (mm)'),
      angleDeg: Type.Number({ description: 'Scan angle, counter-clockwise from +X (deg)' }),
      bidirectional: Type.Boolean({ description: 'Scan back and forth; false scans every line in the same direction' }),
      overscanMm: NonNegative('Distance each scan line runs past the shape with the beam off, so it reaches speed (mm)'),
      crosshatch: Type.Boolean({ description: 'Scan a second time at angleDeg + 90' }),
    },
    { description: 'Fill-mode options. Kept while a layer is in line mode so switching back restores them.', additionalProperties: false },
  ),
)
export type FillSettings = Static<typeof FillSettings>

export const LayerSettings = named(
  'LayerSettings',
  Type.Object(
    {
      mode: LayerMode,
      minPowerPct: Percent('Min power, shown for LightBurn parity; not simulated'),
      maxPowerPct: Percent('Max power, the S the simulation commands'),
      speedMmPerMin: Positive('Feed rate (mm/min)'),
      passes: Type.Integer({ description: 'Number of passes', minimum: 1 }),
      output: Type.Boolean({ description: 'Burn this layer; false shows it without burning (a frame or registration layer)' }),
      visible: Type.Boolean({ description: 'Shown in the design view' }),
      fill: FillSettings,
    },
    {
      description: 'How one SVG colour layer is burned. minPowerPct <= maxPowerPct.',
      additionalProperties: false,
    },
  ),
)
export type LayerSettings = Static<typeof LayerSettings>

/** Fresh settings for a layer: stroke layers default to line, fill-only layers to fill. */
export function defaultLayerSettings(mode: LayerMode): LayerSettings {
  return {
    mode,
    minPowerPct: 0,
    maxPowerPct: 30,
    speedMmPerMin: 1500,
    passes: 1,
    output: true,
    visible: true,
    fill: { intervalMm: 0.1, angleDeg: 0, bidirectional: true, overscanMm: 2, crosshatch: false },
  }
}

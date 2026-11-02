// SPDX-License-Identifier: MIT
// Shared primitives for the v1 contract.
//
// Unit convention: every numeric field carries its unit as a name suffix
// (Mm, MmPerMin, MmPerS, S, W, JPerMm2, K, Deg). Fields without a suffix are
// dimensionless. Coordinates are absolute machine millimetres, X right, Y up,
// origin at the machine's work zero.

import { Type, type Static, type TSchema, type SchemaOptions } from '@sinclair/typebox'

/** Contract major version. Bumped only for breaking changes; additions keep it. */
export const CONTRACT_VERSION = 1 as const

/** Every named schema gets a `$id` so the exporter can hoist it into `$defs`. */
export function named<T extends TSchema>(id: string, schema: T): T {
  return { ...schema, $id: id } as T
}

export const Mm = (description: string, options: SchemaOptions = {}) =>
  Type.Number({ description: `${description} (mm)`, ...options })

export const NonNegative = (description: string, options: SchemaOptions = {}) =>
  Type.Number({ description, minimum: 0, ...options })

export const Positive = (description: string, options: SchemaOptions = {}) =>
  Type.Number({ description, exclusiveMinimum: 0, ...options })

export const Fraction = (description: string) => Type.Number({ description, minimum: 0, maximum: 1 })

export const UInt32 = (description: string, options: SchemaOptions = {}) =>
  Type.Integer({ description, minimum: 0, maximum: 0xffff_ffff, format: 'uint32', ...options })

export const Vec2Mm = named(
  'Vec2Mm',
  Type.Object(
    {
      xMm: Mm('X'),
      yMm: Mm('Y'),
    },
    { description: 'Absolute machine position in mm.', additionalProperties: false },
  ),
)
export type Vec2Mm = Static<typeof Vec2Mm>

export const BoundsMm = named(
  'BoundsMm',
  Type.Object(
    {
      minXMm: Mm('Minimum X'),
      minYMm: Mm('Minimum Y'),
      maxXMm: Mm('Maximum X'),
      maxYMm: Mm('Maximum Y'),
    },
    { description: 'Axis-aligned bounding box in absolute mm; min <= max.', additionalProperties: false },
  ),
)
export type BoundsMm = Static<typeof BoundsMm>

export const Lab = named(
  'Lab',
  Type.Object(
    {
      l: Type.Number({ description: 'CIELAB L* (0..100), D65 white point', minimum: 0, maximum: 100 }),
      a: Type.Number({ description: 'CIELAB a*' }),
      b: Type.Number({ description: 'CIELAB b*' }),
    },
    { description: 'Colour in CIELAB (D65). Calibration samples in Lab, so profiles store Lab.', additionalProperties: false },
  ),
)
export type Lab = Static<typeof Lab>

export const Diagnostic = named(
  'Diagnostic',
  Type.Object(
    {
      severity: Type.Union([Type.Literal('warning'), Type.Literal('error')]),
      code: Type.String({ description: 'Stable machine-readable code, e.g. "unsupported-command"', minLength: 1 }),
      message: Type.String({ description: 'Human-readable message' }),
      line: UInt32('1-based source line; 0 when not tied to a line'),
    },
    { description: 'Parser or planner diagnostic.', additionalProperties: false },
  ),
)
export type Diagnostic = Static<typeof Diagnostic>

/** Where a profile's numbers came from (COD-266 provisional, COD-257 calibrated). */
export const Provenance = named(
  'Provenance',
  Type.Object(
    {
      source: Type.Union([Type.Literal('provisional'), Type.Literal('calibrated'), Type.Literal('user')], {
        description:
          'provisional = published data (COD-266), calibrated = fitted from a photographed grid (COD-257), user = hand-entered',
      }),
      notes: Type.Optional(Type.String({ description: 'Free text: data sources, batch, fit notes' })),
      fittedAt: Type.Optional(Type.String({ description: 'ISO-8601 timestamp of the fit', format: 'date-time' })),
      meanDeltaE: Type.Optional(NonNegative('Mean CIEDE2000 between fitted and photographed cells')),
    },
    { additionalProperties: false },
  ),
)
export type Provenance = Static<typeof Provenance>

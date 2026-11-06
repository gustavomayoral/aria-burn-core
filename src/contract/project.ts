// SPDX-License-Identifier: MIT
// Aria Burn project file, `.ariaburn` (BURN-55, feature BURN-49).
//
// JSON that keeps an SVG import's setup: the SVG text itself (so the project
// opens even if the SVG moved), its original file name, the px-per-inch it was
// read at, each colour layer's settings in burn order, the placement on the
// bed, and the machine and material in effect when it was saved.
//
// Versioned on its own (`version`), apart from CONTRACT_VERSION: additions keep
// the version, a breaking change bumps it and parseProject learns to migrate
// the old one. The webview reads and writes it; Rust only moves the text to and
// from disk, so these schemas are not in ROOT_SCHEMAS.

import { Type, type Static } from '@sinclair/typebox'
import { Mm, Positive, named } from './common.ts'
import { LayerSettings } from './layers.ts'
import { validate } from './registry.ts'

export const PROJECT_FORMAT = 'aria-burn-project' as const
/** Project file version this build writes and the newest it reads. */
export const PROJECT_VERSION = 1 as const
export const PROJECT_EXTENSION = '.ariaburn' as const

export const PlacementAnchor = named(
  'PlacementAnchor',
  Type.Union(
    [
      Type.Literal('top-left'),
      Type.Literal('top'),
      Type.Literal('top-right'),
      Type.Literal('left'),
      Type.Literal('center'),
      Type.Literal('right'),
      Type.Literal('bottom-left'),
      Type.Literal('bottom'),
      Type.Literal('bottom-right'),
    ],
    { description: 'Point of the design box that lands on xMm/yMm (9-point anchor, as in xTool Creative Space).' },
  ),
)

/** aria-burn-core/svg `Placement` as a schema (the svg module's interface is the one code uses). */
export const SvgPlacement = named(
  'SvgPlacement',
  Type.Object(
    {
      xMm: Mm('Bed X of the anchor'),
      yMm: Mm('Bed Y of the anchor'),
      anchor: PlacementAnchor,
      scale: Positive('Uniform scale; 1 is true size'),
      rotationDeg: Type.Number({ description: 'Counter-clockwise about the design centre (deg)' }),
      reference: Type.Optional(
        Type.Union([Type.Literal('page'), Type.Literal('content')], {
          description: "Box the anchor and centre refer to: the SVG page or the drawn geometry. Absent means 'page'.",
        }),
      ),
    },
    { description: 'Where an imported SVG sits on the bed.', additionalProperties: false },
  ),
)
export type SvgPlacement = Static<typeof SvgPlacement>

export const ProjectLayer = named(
  'ProjectLayer',
  Type.Object(
    {
      id: Type.String({ minLength: 1, description: 'Layer key: C00..C29 for a LightBurn palette colour, else the colour hex (#rrggbb)' }),
      settings: LayerSettings,
    },
    { additionalProperties: false },
  ),
)
export type ProjectLayer = Static<typeof ProjectLayer>

const savedName = (what: string) => Type.String({ description: `${what} name when saved, for the notice when the id is gone` })

export const AriaBurnProject = named(
  'AriaBurnProject',
  Type.Object(
    {
      format: Type.Literal(PROJECT_FORMAT),
      version: Type.Integer({ minimum: 1, description: 'Project file version (PROJECT_VERSION when written)' }),
      savedAt: Type.Optional(Type.String({ format: 'date-time' })),
      svg: Type.Object(
        {
          fileName: Type.String({ minLength: 1, description: 'Original SVG file name' }),
          text: Type.String({ description: 'The SVG source, embedded' }),
          pxPerInch: Positive('px per inch the SVG was read at (96, or 72 for older Illustrator exports)'),
        },
        { additionalProperties: false },
      ),
      layers: Type.Array(ProjectLayer, { description: 'Layer settings in burn order (the Layers panel order)' }),
      placement: SvgPlacement,
      machine: Type.Object(
        {
          id: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: 'Machine id; null when the profile was no saved machine' }),
          name: savedName('Machine'),
        },
        { description: 'The machine in effect when saved.', additionalProperties: false },
      ),
      material: Type.Object(
        { id: Type.String({ minLength: 1, description: 'Material id' }), name: savedName('Material') },
        { description: 'The material in effect when saved.', additionalProperties: false },
      ),
    },
    { description: 'An Aria Burn project (.ariaburn): an SVG import with its setup.', additionalProperties: false },
  ),
)
export type AriaBurnProject = Static<typeof AriaBurnProject>

/** The project as written: pretty JSON with a trailing newline, so it diffs well. */
export function serializeProject(project: AriaBurnProject): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

export type ProjectParse = { ok: true; project: AriaBurnProject } | { ok: false; error: string }

/**
 * Reads a project file's text. Rejects text that isn't JSON, isn't an Aria Burn
 * project, comes from a newer Aria Burn, or doesn't match the schema; each with
 * a message for the user. Layer ids must be unique.
 */
export function parseProject(text: string): ProjectParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'This file is not an Aria Burn project (not JSON).' }
  }
  const obj = raw as { format?: unknown; version?: unknown } | null
  if (obj === null || typeof obj !== 'object' || obj.format !== PROJECT_FORMAT)
    return { ok: false, error: 'This file is not an Aria Burn project.' }
  if (typeof obj.version === 'number' && obj.version > PROJECT_VERSION)
    return { ok: false, error: `This project was saved by a newer Aria Burn (file version ${obj.version}; this one reads up to ${PROJECT_VERSION}).` }
  const issues = validate(AriaBurnProject, raw)
  if (issues.length) {
    const shown = issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')
    return { ok: false, error: `This project file is damaged: ${shown}${issues.length > 3 ? ` (and ${issues.length - 3} more)` : ''}.` }
  }
  const project = raw as AriaBurnProject
  const seen = new Set<string>()
  for (const l of project.layers) {
    if (seen.has(l.id)) return { ok: false, error: `This project file is damaged: layer ${l.id} is listed twice.` }
    seen.add(l.id)
  }
  for (const l of project.layers)
    if (l.settings.minPowerPct > l.settings.maxPowerPct)
      return { ok: false, error: `This project file is damaged: layer ${l.id} has min power above max power.` }
  return { ok: true, project }
}

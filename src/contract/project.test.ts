// SPDX-License-Identifier: MIT
// The .ariaburn project file (BURN-55): schema, parse errors, and a round trip
// that makes the same job from the saved setup.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { loadMachineProfile } from '../sim/index.ts'
import { readSvg, svgJob, type Placement } from '../svg/index.ts'
import {
  AriaBurnProject,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  parseProject,
  serializeProject,
  validate,
  type MachineProfile,
  type SvgPlacement,
} from './index.ts'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const MACHINE: MachineProfile = loadMachineProfile(readFileSync(here('../profiles/provisional/machine-10w-diode.json'), 'utf8'))
const HOLES = readFileSync(here('../svg/fixtures/holes.svg'), 'utf8')
const FIXTURE_TEXT = readFileSync(here('./fixtures/project.ariaburn'), 'utf8')

// The schema and the svg module's interface describe the same thing.
const toSchema = (p: Placement): SvgPlacement => p
const toPlacement = (p: SvgPlacement): Placement => p
void toSchema
void toPlacement

function project(): AriaBurnProject {
  const doc = readSvg(HOLES)
  const layers = doc.layers.map((l) => ({ id: l.id, settings: structuredClone(l.settings) }))
  layers.reverse()
  layers[0]!.settings = { ...layers[0]!.settings, maxPowerPct: 55, speedMmPerMin: 900, passes: 2, fill: { ...layers[0]!.settings.fill, angleDeg: 45, crosshatch: true } }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: '2026-11-06T12:00:00Z',
    svg: { fileName: 'holes.svg', text: HOLES, pxPerInch: 96 },
    layers,
    placement: { xMm: 120.5, yMm: 80, anchor: 'center', scale: 1.5, rotationDeg: 30, reference: 'content' },
    machine: { id: 'builtin-default', name: 'Default (10 W diode)' },
    material: { id: 'birch-ply-provisional', name: 'Birch plywood' },
  }
}

describe('project file schema', () => {
  it('the committed fixture validates against the TypeBox schema and as plain JSON Schema', () => {
    const parsed = parseProject(FIXTURE_TEXT)
    expect(parsed).toMatchObject({ ok: true })
    const raw = JSON.parse(FIXTURE_TEXT)
    expect(validate(AriaBurnProject, raw)).toEqual([])
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    const check = ajv.compile(JSON.parse(JSON.stringify(AriaBurnProject)))
    expect(check(raw), JSON.stringify(check.errors)).toBe(true)
  })

  it('is version 1 with the aria-burn-project format tag', () => {
    expect(PROJECT_VERSION).toBe(1)
    expect(JSON.parse(FIXTURE_TEXT)).toMatchObject({ format: 'aria-burn-project', version: 1 })
  })

  it('rejects unknown fields, bad settings and duplicate layers', () => {
    const p = project()
    expect(validate(AriaBurnProject, { ...p, extra: 1 })).not.toEqual([])
    expect(validate(AriaBurnProject, { ...p, placement: { ...p.placement, anchor: 'middle' } })).not.toEqual([])
    expect(validate(AriaBurnProject, { ...p, placement: { ...p.placement, scale: 0 } })).not.toEqual([])
    const bad = structuredClone(p)
    bad.layers[0]!.settings.passes = 0
    expect(parseProject(JSON.stringify(bad))).toMatchObject({ ok: false, error: expect.stringMatching(/damaged/) })
    const dup = structuredClone(p)
    dup.layers.push(structuredClone(dup.layers[0]!))
    expect(parseProject(JSON.stringify(dup))).toMatchObject({ ok: false, error: expect.stringMatching(/listed twice/) })
    const inverted = structuredClone(p)
    inverted.layers[0]!.settings.minPowerPct = 80
    inverted.layers[0]!.settings.maxPowerPct = 20
    expect(parseProject(JSON.stringify(inverted))).toMatchObject({ ok: false, error: expect.stringMatching(/min power/) })
  })

  it('accepts a project whose profile was no saved machine', () => {
    const p = { ...project(), machine: { id: null, name: 'Unsaved machine' } }
    expect(parseProject(serializeProject(p))).toMatchObject({ ok: true })
  })

  it('names what is wrong with a file that is not a project', () => {
    expect(parseProject('<svg/>')).toEqual({ ok: false, error: 'This file is not an Aria Burn project (not JSON).' })
    expect(parseProject('{"format":"lightburn"}')).toEqual({ ok: false, error: 'This file is not an Aria Burn project.' })
    expect(parseProject('null')).toEqual({ ok: false, error: 'This file is not an Aria Burn project.' })
    const newer = parseProject(JSON.stringify({ ...project(), version: 2 }))
    expect(newer).toMatchObject({ ok: false, error: expect.stringMatching(/newer Aria Burn \(file version 2; this one reads up to 1\)/) })
  })
})

describe('project round trip', () => {
  it('serializes to pretty JSON and parses back to the same project', () => {
    const p = project()
    const text = serializeProject(p)
    expect(text.endsWith('}\n')).toBe(true)
    const back = parseProject(text)
    expect(back).toEqual({ ok: true, project: p })
  })

  it('the saved setup makes the same job as the setup it came from', () => {
    const p = project()
    const back = parseProject(serializeProject(p))
    if (!back.ok) throw new Error(back.error)
    const jobOf = (q: AriaBurnProject) => svgJob(readSvg(q.svg.text, { pxPerInch: q.svg.pxPerInch }), q.layers, q.placement, MACHINE, { name: q.svg.fileName })
    const a = jobOf(p)
    const b = jobOf(back.project)
    expect(b.gcode).toBe(a.gcode)
    expect(b.job.moves.length).toBeGreaterThan(0)
    expect(b.job).toEqual(a.job)
  })
})

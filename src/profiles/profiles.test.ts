// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  MachineProfile,
  MaterialProfile,
  buildContractSchema,
  checkMachineProfile,
  checkMaterialProfile,
  validate,
  type MachineProfile as MachineProfileT,
  type MaterialProfile as MaterialProfileT,
} from '../contract/index.ts'
import {
  ACRYLIC_SETTINGS,
  ANODIZED_SETTINGS,
  WOOD_SETTINGS,
  absorbedFluence,
  thresholdBand,
  type PublishedSetting,
} from './provisional/derivation.ts'

const profile = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./provisional/${name}`, import.meta.url)), 'utf8')) as T

const machine = profile<MachineProfileT>('machine-10w-diode.json')
const wood = profile<MaterialProfileT>('birch-ply.json')
const acrylic = profile<MaterialProfileT>('black-cast-acrylic.json')
const anodized = profile<MaterialProfileT>('black-anodized-aluminum.json')
const materials: [string, MaterialProfileT][] = [
  ['birch-ply.json', wood],
  ['black-cast-acrylic.json', acrylic],
  ['black-anodized-aluminum.json', anodized],
]

describe('provisional profiles', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addFormat('uint32', true)
  ajv.addSchema(buildContractSchema())
  const bundle = (id: string) => ajv.getSchema(`${buildContractSchema().$id as string}#/$defs/${id}`)!

  it('machine validates and passes structural checks', () => {
    expect(validate(MachineProfile, machine)).toEqual([])
    expect(bundle('MachineProfile')(machine)).toBe(true)
    expect(checkMachineProfile(machine)).toEqual([])
  })

  it.each(materials)('%s validates and passes ordering checks', (_name, material) => {
    expect(validate(MaterialProfile, material)).toEqual([])
    expect(bundle('MaterialProfile')(material)).toBe(true)
    expect(checkMaterialProfile(material)).toEqual([])
  })

  it('every profile is labelled provisional', () => {
    for (const p of [machine, ...materials.map(([, m]) => m)]) {
      expect(p.provenance.source).toBe('provisional')
      expect(p.provenance.notes).toMatch(/^PROVISIONAL - not validated against real burns/)
    }
  })
})

describe('thresholds match the published-settings derivation (SOURCES.md)', () => {
  const band = (settings: PublishedSetting[], m: MaterialProfileT) =>
    thresholdBand(settings.map((s) => absorbedFluence(s, machine.powerCurve, m.absorption)))
  const near = (actual: number, expected: number) => expect(Math.abs(actual - expected) / expected).toBeLessThan(0.03)

  it('wood', () => {
    const b = band(WOOD_SETTINGS, wood)
    if (wood.response.kind !== 'char') throw new Error('expected char')
    near(wood.response.toneStartJPerMm2, b.start)
    near(wood.response.ablationThresholdJPerMm2, b.mid)
    near(wood.response.toneEndJPerMm2, b.over)
    // toneGamma puts the median good engrave at half tone.
    const t = (b.mid - wood.response.toneStartJPerMm2) / (wood.response.toneEndJPerMm2 - wood.response.toneStartJPerMm2)
    expect(t ** wood.response.toneGamma).toBeCloseTo(0.5, 1)
  })

  it('acrylic', () => {
    const b = band(ACRYLIC_SETTINGS, acrylic)
    if (acrylic.response.kind !== 'melt') throw new Error('expected melt')
    near(acrylic.response.frostStartJPerMm2, b.start)
    near(acrylic.response.frostFullJPerMm2, b.mid)
    near(acrylic.response.removalThresholdJPerMm2, b.over)
  })

  it('anodized aluminum', () => {
    const b = band(ANODIZED_SETTINGS, anodized)
    if (anodized.response.kind !== 'bleach') throw new Error('expected bleach')
    near(anodized.response.markStartJPerMm2, b.start)
    near(anodized.response.markFullJPerMm2, b.mid)
    near(anodized.response.damageThresholdJPerMm2, b.over)
  })
})

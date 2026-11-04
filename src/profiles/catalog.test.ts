// SPDX-License-Identifier: MIT
// Machine catalog (BURN-30): every frame and module validates, every frame ×
// listed module combines into a valid MachineProfile that runs a reference
// job through the planner stand-in and the CPU sim.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import {
  CONSERVATION_TOLERANCE,
  LaserModule,
  MachineFrame,
  MachineProfile,
  Verdict,
  buildContractSchema,
  checkCatalog,
  checkLaserModule,
  checkMachineFrame,
  combineMachine,
  decodeSampleBatch,
  provisionalFields,
  validate,
  type LaserModule as LaserModuleT,
  type MachineFrame as MachineFrameT,
} from '../contract/index.ts'
import {
  SampleStore,
  interimSampler,
  loadCatalogMachine,
  loadLaserModule,
  loadMachineFrame,
  loadMachineProfile,
  loadMaterialProfile,
  setupJob,
  simulateCpu,
  stitch,
} from '../sim/index.ts'
import { concatJobs, rasterJob, squareJob } from '../sim/test-jobs.ts'

const dir = (sub: string) => fileURLToPath(new URL(`./catalog/${sub}/`, import.meta.url))
const readAll = (sub: string): [string, unknown][] =>
  readdirSync(dir(sub))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(dir(sub) + f, 'utf8')) as unknown])

const frameFiles = readAll('frames')
const moduleFiles = readAll('modules')
const frames = frameFiles.map(([f, v]) => loadMachineFrame(v, f))
const modules = moduleFiles.map(([f, v]) => loadLaserModule(v, f))
const moduleById = new Map(modules.map((m) => [m.id, m]))
const combos: [string, MachineFrameT, LaserModuleT][] = frames.flatMap((f) =>
  f.modules.map((id) => [`${f.id} + ${id}`, f, moduleById.get(id)!] as [string, MachineFrameT, LaserModuleT]),
)

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
ajv.addFormat('uint32', true)
ajv.addSchema(buildContractSchema())
const bundle = (id: string) => ajv.getSchema(`${buildContractSchema().$id as string}#/$defs/${id}`)!

describe('catalog files', () => {
  it('has a first-pass catalog of about a dozen machines', () => {
    expect(frames.length).toBeGreaterThanOrEqual(10)
    expect(frames.length).toBeLessThanOrEqual(12)
  })

  it('file names match ids, ids are unique, every listed module exists and every module is used', () => {
    for (const [f, v] of [...frameFiles, ...moduleFiles]) expect(f).toBe(`${(v as { id: string }).id}.json`)
    expect(checkCatalog(frames, modules)).toEqual([])
  })

  it.each(frameFiles)('frame %s validates against TypeBox, the exported JSON Schema and structural checks', (_f, v) => {
    expect(validate(MachineFrame, v)).toEqual([])
    const check = bundle('MachineFrame')
    expect(check(v), JSON.stringify(check.errors)).toBe(true)
    expect(checkMachineFrame(v as MachineFrameT)).toEqual([])
  })

  it.each(moduleFiles)('module %s validates against TypeBox, the exported JSON Schema and structural checks', (_f, v) => {
    expect(validate(LaserModule, v)).toEqual([])
    const check = bundle('LaserModule')
    expect(check(v), JSON.stringify(check.errors)).toBe(true)
    expect(checkLaserModule(v as LaserModuleT)).toEqual([])
  })

  it('marketing figures (optical power, spot, power curve) are marked provisional in every module', () => {
    for (const m of modules) {
      expect(m.fieldStatus.opticalPowerW, m.id).toBe('provisional')
      expect(m.fieldStatus.spot, m.id).toBe('provisional')
      expect(m.fieldStatus.powerCurve, m.id).toBe('provisional')
      expect(m.provenance.source).toBe('provisional')
      expect(m.provenance.notes).toMatch(/^PROVISIONAL - not validated against real burns/)
    }
  })

  it('every frame points at its SOURCES.md section', () => {
    const sources = readFileSync(fileURLToPath(new URL('./catalog/SOURCES.md', import.meta.url)), 'utf8')
    for (const f of frames) {
      expect(f.provenance.notes).toContain(`SOURCES.md#${f.id}`)
      expect(sources, f.id).toContain(`<a id="${f.id}"></a>`)
    }
    for (const m of modules) expect(sources, m.id).toContain(`<a id="${m.id}"></a>`)
  })
})

describe('combineMachine', () => {
  const frame = frames.find((f) => f.id === 'sculpfun-s30')!
  const tenW = moduleById.get('sculpfun-s30-pro-10w')!
  const fiveW = moduleById.get('sculpfun-s30-5w')!

  it('takes motion and $ settings from the frame and the laser from the module', () => {
    const p = combineMachine(frame, tenW)
    expect(validate(MachineProfile, p)).toEqual([])
    expect(bundle('MachineProfile')(p)).toBe(true)
    expect(p).toMatchObject({
      name: 'Sculpfun S30 / S30 Pro + S30 Pro 10 W',
      sMax: frame.sMax,
      laserMode: frame.laserMode,
      junctionDeviationMm: frame.junctionDeviationMm,
      maxRateMmPerMin: frame.maxRateMmPerMin,
      accelMmPerS2: frame.accelMmPerS2,
      travelMm: frame.travelMm,
      opticalPowerW: tenW.opticalPowerW,
      wavelengthNm: tenW.wavelengthNm,
      powerCurve: tenW.powerCurve,
      frameId: frame.id,
      moduleId: tenW.id,
    })
  })

  it('converts published 1/e² diameters to Gaussian sigma = d / 4, long axis first', () => {
    const p = combineMachine(frame, tenW)
    expect(p.spot.sigmaXMm).toBeCloseTo(tenW.spot.majorDiameterMm / 4, 12)
    expect(p.spot.sigmaYMm).toBeCloseTo(tenW.spot.minorDiameterMm / 4, 12)
    expect(p.spot.angleDeg).toBe(tenW.spot.angleDeg)
  })

  it('swapping the module on one frame changes only the laser fields', () => {
    const a = combineMachine(frame, tenW)
    const b = combineMachine(frame, fiveW)
    const laser = ['name', 'opticalPowerW', 'spot', 'powerCurve', 'wavelengthNm', 'moduleId', 'provenance'] as const
    const strip = (p: Record<string, unknown>) => Object.fromEntries(Object.entries(p).filter(([k]) => !(laser as readonly string[]).includes(k)))
    expect(strip(b)).toEqual(strip(a))
    expect(b.opticalPowerW).toBe(5)
  })

  it('a module shared by two frames (Ortur LU2-10A) keeps its laser and takes each frame motion', () => {
    const lu2 = moduleById.get('ortur-lu2-10a')!
    const [lm2, lm3] = ['ortur-lm2-pro-s2', 'ortur-lm3'].map((id) => frames.find((f) => f.id === id)!)
    const a = combineMachine(lm2!, lu2)
    const b = combineMachine(lm3!, lu2)
    expect(a.spot).toEqual(b.spot)
    expect(a.maxRateMmPerMin).toEqual(lm2!.maxRateMmPerMin)
    expect(b.maxRateMmPerMin).toEqual(lm3!.maxRateMmPerMin)
  })

  it('carries provisional status and lists every provisional field in the notes', () => {
    const p = combineMachine(frame, tenW)
    expect(p.provenance.source).toBe('provisional')
    expect(p.provenance.label).toMatch(/^provisional/)
    expect(p.provenance.notes).toMatch(/^PROVISIONAL fields: /)
    for (const f of provisionalFields(frame, tenW)) expect(p.provenance.notes).toContain(f)
    expect(provisionalFields(frame, tenW)).toContain('module.opticalPowerW')
    expect(provisionalFields(frame, tenW).some((f) => f.startsWith('frame.'))).toBe(false)
  })

  it('a fully calibrated frame and module combine into a calibrated profile', () => {
    const cal = { source: 'calibrated' as const }
    const f: MachineFrameT = {
      ...frame,
      provenance: cal,
      fieldStatus: Object.fromEntries(Object.keys(frame.fieldStatus).map((k) => [k, 'sourced'])) as MachineFrameT['fieldStatus'],
    }
    const m: LaserModuleT = {
      ...tenW,
      provenance: cal,
      fieldStatus: { opticalPowerW: 'sourced', wavelengthNm: 'sourced', spot: 'sourced', powerCurve: 'sourced' },
    }
    const p = combineMachine(f, m)
    expect(p.provenance.source).toBe('calibrated')
    expect(p.provenance.label).toBeUndefined()
    expect(validate(MachineProfile, p)).toEqual([])
  })

  it('is a copy: editing the profile does not touch the catalog data', () => {
    const p = combineMachine(frame, tenW)
    p.maxRateMmPerMin.x = 1
    p.powerCurve[1]!.power = 0.5
    expect(frame.maxRateMmPerMin.x).not.toBe(1)
    expect(tenW.powerCurve[1]!.power).toBe(0)
  })

  it('existing hand-built profiles stay valid without the new optional fields', () => {
    const legacy = readFileSync(fileURLToPath(new URL('./provisional/machine-10w-diode.json', import.meta.url)), 'utf8')
    expect(loadMachineProfile(legacy).frameId).toBeUndefined()
  })
})

describe('every catalog machine runs a reference job through planner + sim', () => {
  const wood = loadMaterialProfile(
    readFileSync(fileURLToPath(new URL('./provisional/birch-ply.json', import.meta.url)), 'utf8'),
  )
  const job = concatJobs(
    rasterJob({ x0Mm: 0.3, y0Mm: 0.3, widthMm: 1.4, heightMm: 0.6, intervalMm: 0.05, feedMmPerMin: 3000, s: 300 }),
    squareJob(0.2, 0.2, 2, 600, 900, 'm3'),
  )

  it.each(combos)('%s', (_name, frame, module) => {
    const machine = loadCatalogMachine(frame, module)
    const plan = interimSampler.plan(job, machine, 1)
    expect(plan.batches.length).toBeGreaterThan(0)
    const store = new SampleStore(1)
    for (const b of plan.batches) store.append(decodeSampleBatch(b))
    const setup = setupJob(job.burnBounds!, machine, wood)
    const run = simulateCpu(store, setup)
    expect(run.energy.expectedJ).toBeGreaterThan(0)
    expect(Math.abs(run.energy.depositJ - run.energy.expectedJ) / run.energy.expectedJ).toBeLessThan(CONSERVATION_TOLERANCE)
    const out = stitch(run)
    expect(out.verdict.some((v) => v !== Verdict.Untouched)).toBe(true)
  })
})

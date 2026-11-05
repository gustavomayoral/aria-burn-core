// SPDX-License-Identifier: MIT
// Machine catalog (BURN-30): a machine profile is a frame plus a laser module.
//
// The frame is the motion system and its emulated GRBL `$` settings; the module
// is the diode head. Many machines ship with interchangeable modules (a 5 W
// head upgraded to 20 W on the same frame), so a frame lists the module ids it
// takes and `combineMachine` builds the MachineProfile the planner and sim use.
//
// Frame fields keep GRBL's names and units so a `$$` dump or LightBurn device
// file maps onto them one to one (BURN-31). Every field carries a status:
// `sourced` (manufacturer spec or a published `$$` dump) or `provisional`
// (vendor marketing figure, or a common default where nothing was published).

import { Type, type Static } from '@sinclair/typebox'
import { CONTRACT_VERSION, Positive, Provenance, named } from './common.ts'
import { AxisPair, PowerCurvePoint, ScanOffsetCurve, checkPowerCurve, checkScanOffset, type MachineProfile } from './machine.ts'

const CatalogId = (description: string) =>
  Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', minLength: 1, maxLength: 64, description })

export const FieldStatus = named(
  'FieldStatus',
  Type.Union([Type.Literal('sourced'), Type.Literal('provisional')], {
    description:
      'sourced = manufacturer spec or published `$$` dump; provisional = vendor marketing figure or an assumed common default, to be replaced by measurement (BURN-12).',
  }),
)
export type FieldStatus = Static<typeof FieldStatus>

export const MachineFrame = named(
  'MachineFrame',
  Type.Object(
    {
      contractVersion: Type.Literal(CONTRACT_VERSION),
      id: CatalogId('Stable catalog id, e.g. "sculpfun-s30"'),
      brand: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1, description: 'Display name, e.g. "Sculpfun S30 / S30 Pro"' }),
      firmware: Type.Literal('grbl', { description: 'Only GRBL machines are catalogued; the emulator speaks GRBL only.' }),
      workAreaMm: AxisPair('Vendor-stated engraving area (bed size)', 'mm'),
      sMax: Positive('$30 maximum S value'),
      laserMode: Type.Boolean({ description: '$32 laser mode' }),
      junctionDeviationMm: Positive('$11 junction deviation (mm)'),
      maxRateMmPerMin: AxisPair('$110/$111 max rate', 'mm/min'),
      accelMmPerS2: AxisPair('$120/$121 acceleration', 'mm/s²'),
      travelMm: AxisPair('$130/$131 max travel', 'mm'),
      scanOffsetMm: Type.Optional(
        ScanOffsetCurve(
          'Forward/back line shift of bidirectional X fills (BURN-48), measured with the scan-offset calibration pattern (BURN-47). Not a GRBL setting. Catalog frames ship it empty (no offset), marked provisional.',
        ),
      ),
      modules: Type.Array(CatalogId('LaserModule id'), {
        minItems: 1,
        uniqueItems: true,
        description: 'Laser modules this frame takes, stock module first.',
      }),
      fieldStatus: Type.Object(
        {
          workAreaMm: FieldStatus,
          sMax: FieldStatus,
          laserMode: FieldStatus,
          junctionDeviationMm: FieldStatus,
          maxRateMmPerMin: FieldStatus,
          accelMmPerS2: FieldStatus,
          travelMm: FieldStatus,
          scanOffsetMm: Type.Optional(FieldStatus),
        },
        { additionalProperties: false, description: 'Where each frame value came from.' },
      ),
      provenance: Provenance,
    },
    { description: 'Machine frame: motion system and emulated GRBL `$` settings (BURN-30).', additionalProperties: false },
  ),
)
export type MachineFrame = Static<typeof MachineFrame>

export const ModuleSpot = named(
  'ModuleSpot',
  Type.Object(
    {
      majorDiameterMm: Positive('1/e² diameter along the long axis of the spot (mm)'),
      minorDiameterMm: Positive('1/e² diameter along the short axis of the spot (mm)'),
      angleDeg: Type.Number({
        description: 'Rotation of the long axis from machine +X, counter-clockwise (degrees). Depends on how the module is mounted.',
        minimum: -180,
        maximum: 180,
      }),
    },
    { description: 'Diode spot as published (width × height at 1/e²). combineMachine converts to Gaussian sigma = d / 4.', additionalProperties: false },
  ),
)
export type ModuleSpot = Static<typeof ModuleSpot>

export const LaserModule = named(
  'LaserModule',
  Type.Object(
    {
      contractVersion: Type.Literal(CONTRACT_VERSION),
      id: CatalogId('Stable catalog id, e.g. "sculpfun-s30-pro-10w"'),
      brand: Type.String({ minLength: 1 }),
      name: Type.String({ minLength: 1, description: 'Display name, e.g. "S30 Pro 10 W"' }),
      opticalPowerW: Positive('Optical output at full power (W). Not electrical input power.'),
      wavelengthNm: Positive('Emission wavelength (nm)'),
      spot: ModuleSpot,
      powerCurve: Type.Array(PowerCurvePoint, {
        minItems: 2,
        description: 'S → optical power lookup, as MachineProfile.powerCurve.',
      }),
      fieldStatus: Type.Object(
        {
          opticalPowerW: FieldStatus,
          wavelengthNm: FieldStatus,
          spot: FieldStatus,
          powerCurve: FieldStatus,
        },
        { additionalProperties: false, description: 'Where each module value came from.' },
      ),
      provenance: Provenance,
    },
    { description: 'Laser module: the diode head that mounts on a frame (BURN-30).', additionalProperties: false },
  ),
)
export type LaserModule = Static<typeof LaserModule>

/** Field names marked provisional, prefixed `frame.` / `module.`. */
export function provisionalFields(frame: MachineFrame, module: LaserModule): string[] {
  const list = (prefix: string, status: Record<string, FieldStatus>) =>
    Object.entries(status)
      .filter(([, s]) => s === 'provisional')
      .map(([k]) => `${prefix}.${k}`)
  return [...list('frame', frame.fieldStatus), ...list('module', module.fieldStatus)]
}

/**
 * The MachineProfile for a module mounted on a frame. Any module can be combined
 * with any frame (users swap heads); `checkCatalog` checks the catalog's own lists.
 */
export function combineMachine(frame: MachineFrame, module: LaserModule): MachineProfile {
  const provisional = provisionalFields(frame, module)
  const sources = [frame.provenance.source, module.provenance.source]
  const source = provisional.length || sources.includes('provisional') ? 'provisional' : sources.every((s) => s === 'calibrated') ? 'calibrated' : 'user'
  const notes = [
    provisional.length ? `PROVISIONAL fields: ${provisional.join(', ')}.` : 'All fields sourced.',
    frame.provenance.notes && `Frame: ${frame.provenance.notes}`,
    module.provenance.notes && `Module: ${module.provenance.notes}`,
  ]
    .filter(Boolean)
    .join(' ')
  return {
    contractVersion: CONTRACT_VERSION,
    name: `${frame.name} + ${module.name}`,
    opticalPowerW: module.opticalPowerW,
    sMax: frame.sMax,
    laserMode: frame.laserMode,
    junctionDeviationMm: frame.junctionDeviationMm,
    maxRateMmPerMin: { ...frame.maxRateMmPerMin },
    accelMmPerS2: { ...frame.accelMmPerS2 },
    travelMm: { ...frame.travelMm },
    // Copied when the frame has one (catalog frames: empty, i.e. no offset); a frame from before BURN-48 leaves it out.
    ...(frame.scanOffsetMm ? { scanOffsetMm: frame.scanOffsetMm.map((p) => ({ ...p })) } : {}),
    spot: {
      sigmaXMm: module.spot.majorDiameterMm / 4,
      sigmaYMm: module.spot.minorDiameterMm / 4,
      angleDeg: module.spot.angleDeg,
    },
    powerCurve: module.powerCurve.map((p) => ({ ...p })),
    wavelengthNm: module.wavelengthNm,
    frameId: frame.id,
    moduleId: module.id,
    provenance: {
      source,
      ...(source === 'provisional' ? { label: 'provisional — vendor figures, not measured on a real laser' } : {}),
      notes,
    },
  }
}

/** Structural checks JSON Schema can't express. Returns problems; empty means valid. */
export function checkMachineFrame(frame: MachineFrame): string[] {
  const problems: string[] = []
  if (!frame.laserMode) problems.push('laserMode ($32) must be true for a diode laser frame')
  problems.push(...checkScanOffset(frame.scanOffsetMm))
  if (frame.scanOffsetMm && !frame.fieldStatus.scanOffsetMm) problems.push('fieldStatus.scanOffsetMm is required when scanOffsetMm is set')
  return problems
}

/** Structural checks JSON Schema can't express. Returns problems; empty means valid. */
export function checkLaserModule(module: LaserModule): string[] {
  const problems = checkPowerCurve(module.powerCurve)
  if (module.spot.minorDiameterMm > module.spot.majorDiameterMm) problems.push('spot.majorDiameterMm must be >= minorDiameterMm')
  return problems
}

/** Cross-file checks over a whole catalog: unique ids, every listed module exists, every module is used. */
export function checkCatalog(frames: readonly MachineFrame[], modules: readonly LaserModule[]): string[] {
  const problems: string[] = []
  const dup = (ids: string[], kind: string) => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${kind} id ${id}`)
      seen.add(id)
    }
  }
  dup(frames.map((f) => f.id), 'frame')
  dup(modules.map((m) => m.id), 'module')
  const moduleIds = new Set(modules.map((m) => m.id))
  const used = new Set<string>()
  for (const f of frames) {
    for (const id of f.modules) {
      if (!moduleIds.has(id)) problems.push(`frame ${f.id} lists unknown module ${id}`)
      used.add(id)
    }
  }
  for (const m of modules) if (!used.has(m.id)) problems.push(`module ${m.id} is on no frame`)
  return problems
}

/** MachineProfile fields a catalog frame or module sets (BURN-31 marks each one in the UI). */
export const PROFILE_FRAME_FIELDS = ['sMax', 'laserMode', 'junctionDeviationMm', 'maxRateMmPerMin', 'accelMmPerS2', 'travelMm', 'scanOffsetMm'] as const
export const PROFILE_MODULE_FIELDS = ['opticalPowerW', 'wavelengthNm', 'spot', 'powerCurve'] as const
export type ProfileField = (typeof PROFILE_FRAME_FIELDS)[number] | (typeof PROFILE_MODULE_FIELDS)[number]

/**
 * The status of each MachineProfile field `combineMachine(frame, module)` sets,
 * keyed by the profile's field name. The frame's `workAreaMm` has no profile
 * field and is left out.
 */
export function profileFieldStatus(frame: MachineFrame, module: LaserModule): Record<ProfileField, FieldStatus> {
  const out = {} as Record<ProfileField, FieldStatus>
  // A frame from before BURN-48 has no scanOffsetMm status: its (zero) offset is an assumption.
  for (const k of PROFILE_FRAME_FIELDS) out[k] = frame.fieldStatus[k] ?? 'provisional'
  for (const k of PROFILE_MODULE_FIELDS) out[k] = module.fieldStatus[k]
  return out
}

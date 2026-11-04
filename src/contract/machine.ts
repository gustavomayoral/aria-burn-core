// SPDX-License-Identifier: MIT
// Machine profile (COD-255, COD-256). The profile *is* the emulated GRBL `$`
// settings, plus the laser parameters needed for absolute fluence.

import { Type, type Static } from '@sinclair/typebox'
import { CONTRACT_VERSION, Fraction, Positive, Provenance, named } from './common.ts'

export const AxisPair = (description: string, unit: string) =>
  Type.Object(
    {
      x: Positive(`${description}, X axis (${unit})`),
      y: Positive(`${description}, Y axis (${unit})`),
    },
    { additionalProperties: false },
  )

export const Spot = named(
  'Spot',
  Type.Object(
    {
      sigmaXMm: Positive('Gaussian sigma along the spot major axis before rotation (mm). For a 1/e² diameter d, sigma = d / 4.'),
      sigmaYMm: Positive('Gaussian sigma along the spot minor axis before rotation (mm)'),
      angleDeg: Type.Number({
        description: 'Rotation of the spot X axis from machine +X, counter-clockwise (degrees)',
        minimum: -180,
        maximum: 180,
      }),
    },
    { description: 'Anisotropic diode spot as an elliptical Gaussian (COD-256).', additionalProperties: false },
  ),
)
export type Spot = Static<typeof Spot>

export const PowerCurvePoint = named(
  'PowerCurvePoint',
  Type.Object(
    {
      s: Fraction('Commanded S as a fraction of $30'),
      power: Fraction('Optical power as a fraction of opticalPowerW'),
    },
    { additionalProperties: false },
  ),
)
export type PowerCurvePoint = Static<typeof PowerCurvePoint>

export const MachineProfile = named(
  'MachineProfile',
  Type.Object(
    {
      contractVersion: Type.Literal(CONTRACT_VERSION),
      name: Type.String({ minLength: 1 }),
      opticalPowerW: Positive('Laser optical output at full power (W). Not electrical input power.'),
      sMax: Positive('$30 maximum S value'),
      laserMode: Type.Boolean({ description: '$32 laser mode. When true, M4 scales power with actual speed and g0 is beam-off.' }),
      junctionDeviationMm: Positive('$11 junction deviation (mm)'),
      maxRateMmPerMin: AxisPair('$110/$111 max rate', 'mm/min'),
      accelMmPerS2: AxisPair('$120/$121 acceleration', 'mm/s²'),
      travelMm: AxisPair('$130/$131 max travel', 'mm'),
      spot: Spot,
      powerCurve: Type.Array(PowerCurvePoint, {
        minItems: 2,
        description:
          'S → optical power lookup, linear between points, sorted by s with strictly increasing s, non-decreasing power. Must start at s = 0 and end at s = 1.',
      }),
      wavelengthNm: Type.Optional(Positive('Laser module emission wavelength (nm). Informational; the v1 burn model does not use it.')),
      frameId: Type.Optional(
        Type.String({ minLength: 1, description: 'Catalog MachineFrame id this profile was combined from (BURN-30). Absent for hand-built profiles.' }),
      ),
      moduleId: Type.Optional(
        Type.String({ minLength: 1, description: 'Catalog LaserModule id this profile was combined from (BURN-30). Absent for hand-built profiles.' }),
      ),
      provenance: Provenance,
    },
    {
      description: 'Machine profile and emulated GRBL settings. Catalog profiles are a MachineFrame plus a LaserModule (combineMachine).',
      additionalProperties: false,
    },
  ),
)
export type MachineProfile = Static<typeof MachineProfile>

/**
 * Optical power (W) for a commanded S at a given actual speed, per GRBL laser
 * mode. M4 scales by actual / programmed speed (GRBL's dynamic power); M3 does not.
 * The planner (Rust) owns this computation; this TS twin is the reference for tests.
 */
export function opticalPowerW(
  profile: Pick<MachineProfile, 'opticalPowerW' | 'sMax' | 'laserMode' | 'powerCurve'>,
  s: number,
  mode: 'off' | 'm3' | 'm4',
  actualMmPerMin: number,
  programmedMmPerMin: number,
): number {
  if (mode === 'off' || s <= 0) return 0
  let sEff = Math.min(s, profile.sMax) / profile.sMax
  if (mode === 'm4' && profile.laserMode && programmedMmPerMin > 0) {
    sEff *= Math.min(1, Math.max(0, actualMmPerMin / programmedMmPerMin))
  }
  return profile.opticalPowerW * interpolateCurve(profile.powerCurve, sEff)
}

export function interpolateCurve(curve: readonly PowerCurvePoint[], s: number): number {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!first || !last) throw new Error('power curve needs at least two points')
  if (s <= first.s) return first.power
  if (s >= last.s) return last.power
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i]!
    if (s <= b.s) {
      const a = curve[i - 1]!
      return a.power + ((s - a.s) / (b.s - a.s)) * (b.power - a.power)
    }
  }
  return last.power
}

/** Structural checks JSON Schema can't express. Returns problems; empty means valid. */
export function checkMachineProfile(profile: MachineProfile): string[] {
  const problems = checkPowerCurve(profile.powerCurve)
  if (profile.spot.sigmaYMm > profile.spot.sigmaXMm) problems.push('spot.sigmaXMm must be the major axis (>= sigmaYMm)')
  return problems
}

/** Power-curve ordering rules shared by MachineProfile and LaserModule. */
export function checkPowerCurve(c: readonly PowerCurvePoint[]): string[] {
  const problems: string[] = []
  if (c[0]?.s !== 0) problems.push('powerCurve must start at s = 0')
  if (c[c.length - 1]?.s !== 1) problems.push('powerCurve must end at s = 1')
  for (let i = 1; i < c.length; i++) {
    if (c[i]!.s <= c[i - 1]!.s) problems.push(`powerCurve[${i}].s must be greater than the previous point`)
    if (c[i]!.power < c[i - 1]!.power) problems.push(`powerCurve[${i}].power must not decrease`)
  }
  return problems
}

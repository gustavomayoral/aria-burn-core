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

/** Largest scan offset the contract accepts (mm). The BURN-47 pick card takes the same range. */
export const SCAN_OFFSET_MAX_MM = 5

export const ScanOffsetPoint = named(
  'ScanOffsetPoint',
  Type.Object(
    {
      feedMmPerMin: Positive('Programmed feed of the scan line (mm/min)'),
      offsetMm: Type.Number({
        description:
          'How far lines scanned in -X land from lines scanned in +X at this feed (mm). Positive = further along -X (the reverse line lands past where it was programmed, in its direction of travel).',
        minimum: -SCAN_OFFSET_MAX_MM,
        maximum: SCAN_OFFSET_MAX_MM,
      }),
    },
    { additionalProperties: false },
  ),
)
export type ScanOffsetPoint = Static<typeof ScanOffsetPoint>

/**
 * Bidirectional scan line shift against feed (BURN-48). Measured by the
 * BURN-47 scan offset pattern. See `scanOffsetAt` for how it is read.
 */
export const ScanOffsetCurve = (description: string) =>
  Type.Array(ScanOffsetPoint, {
    description: `${description} Feed → offset of reverse (-X) scan lines against forward (+X) ones, sorted by strictly increasing feed. Linear between points, linear from 0 mm at feed 0 up to the first point, and flat past the last point. Empty (or absent) means no offset at any feed.`,
  })

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
      scanOffsetMm: Type.Optional(ScanOffsetCurve('Scan offset of the frame (BURN-48), copied from MachineFrame.scanOffsetMm or applied from a reading.')),
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

/**
 * Scan offset (mm) at a programmed feed (BURN-48). Positive moves a reverse
 * (-X) scan line further along -X. No points: 0. Below the first point the
 * offset rises linearly from 0 at feed 0 (a stopped head has no shift); between
 * points it is linear; past the last point it stays at the last value rather
 * than extrapolating beyond what was measured.
 */
export function scanOffsetAt(curve: readonly ScanOffsetPoint[] | undefined, feedMmPerMin: number): number {
  if (!curve || curve.length === 0 || !(feedMmPerMin > 0)) return 0
  const last = curve[curve.length - 1]!
  if (feedMmPerMin >= last.feedMmPerMin) return last.offsetMm
  let a: ScanOffsetPoint = { feedMmPerMin: 0, offsetMm: 0 }
  for (const b of curve) {
    if (feedMmPerMin <= b.feedMmPerMin) return a.offsetMm + ((feedMmPerMin - a.feedMmPerMin) / (b.feedMmPerMin - a.feedMmPerMin)) * (b.offsetMm - a.offsetMm)
    a = b
  }
  return last.offsetMm
}

/**
 * Scan lines the offset applies to: beam-on moves within this angle of -X
 * (degrees). Vectors and Y scans are left alone; the BURN-47 pattern measures
 * X scans only.
 */
export const SCAN_OFFSET_ANGLE_DEG = 1

/** True when a move with unit direction (ux, uy) is a reverse X scan line. */
export function isReverseScan(ux: number, uy: number): boolean {
  return ux < 0 && Math.abs(uy) <= Math.abs(ux) * Math.tan((SCAN_OFFSET_ANGLE_DEG * Math.PI) / 180)
}

/**
 * Burn bounds widened for the scan offset (BURN-48): reverse lines move by
 * -offset along X, so the largest positive offset extends the burn to the
 * left and the most negative one to the right. The bounds themselves when
 * there is no offset.
 */
export function scanOffsetBounds<B extends { minXMm: number; maxXMm: number }>(bounds: B, curve: readonly ScanOffsetPoint[] | undefined): B {
  if (!curve?.length) return bounds
  let left = 0
  let right = 0
  for (const p of curve) {
    left = Math.max(left, p.offsetMm)
    right = Math.max(right, -p.offsetMm)
  }
  return left === 0 && right === 0 ? bounds : { ...bounds, minXMm: bounds.minXMm - left, maxXMm: bounds.maxXMm + right }
}

/** Scan offset ordering rules shared by MachineProfile and MachineFrame. */
export function checkScanOffset(c: readonly ScanOffsetPoint[] | undefined): string[] {
  const problems: string[] = []
  if (!c) return problems
  for (let i = 1; i < c.length; i++)
    if (c[i]!.feedMmPerMin <= c[i - 1]!.feedMmPerMin) problems.push(`scanOffsetMm[${i}].feedMmPerMin must be greater than the previous point`)
  return problems
}

/** Structural checks JSON Schema can't express. Returns problems; empty means valid. */
export function checkMachineProfile(profile: MachineProfile): string[] {
  const problems = [...checkPowerCurve(profile.powerCurve), ...checkScanOffset(profile.scanOffsetMm)]
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

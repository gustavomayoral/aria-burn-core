// SPDX-License-Identifier: MIT
// Material profile schema (COD-250 response kinds, COD-257 calibration,
// COD-258 thermal slot). Each kind declares only the fields it uses; every
// response parameter is a threshold or slope on fluence so calibration fits
// never need a schema change.

import { Type, type Static } from '@sinclair/typebox'
import { CONTRACT_VERSION, Fraction, Lab, NonNegative, Positive, Provenance, named } from './common.ts'

const Fluence = (description: string) => NonNegative(`${description} (J/mm²)`)

export const CharResponse = named(
  'CharResponse',
  Type.Object(
    {
      kind: Type.Literal('char'),
      baseColor: Lab,
      charColor: Lab,
      toneStartJPerMm2: Fluence('Fluence where darkening starts; below this the cell is under-burned'),
      toneEndJPerMm2: Fluence('Fluence where the tone ramp reaches charColor; above this the cell is over-burned'),
      toneGamma: Positive('Ramp shape between start and end; 1 = linear in fluence'),
      ablationThresholdJPerMm2: Fluence('Fluence where material removal starts (height map)'),
      depthMmPerJPerMm2: NonNegative('Depth per unit fluence above the ablation threshold (mm per J/mm²)'),
    },
    {
      description: 'Wood, leather, paper. Darkening happens well below removal: toneStart <= toneEnd, toneStart <= ablationThreshold.',
      additionalProperties: false,
    },
  ),
)
export type CharResponse = Static<typeof CharResponse>

export const MeltResponse = named(
  'MeltResponse',
  Type.Object(
    {
      kind: Type.Literal('melt'),
      baseColor: Lab,
      frostColor: Lab,
      frostStartJPerMm2: Fluence('Fluence where frosting starts; below this the cell is under-burned'),
      frostFullJPerMm2: Fluence('Fluence of full frost'),
      removalThresholdJPerMm2: Fluence('Fluence where material removal starts; above this the cell is over-burned'),
      depthMmPerJPerMm2: NonNegative('Depth per unit fluence above the removal threshold (mm per J/mm²)'),
    },
    {
      description:
        'Dark/colored cast acrylic. A polished edge is a high-fluence neighbour of a removed cell (output-stage rule, no field).',
      additionalProperties: false,
    },
  ),
)
export type MeltResponse = Static<typeof MeltResponse>

export const BleachResponse = named(
  'BleachResponse',
  Type.Object(
    {
      kind: Type.Literal('bleach'),
      baseColor: Lab,
      markColor: Lab,
      markStartJPerMm2: Fluence('Fluence where marking starts; below this the cell is under-burned'),
      markFullJPerMm2: Fluence('Fluence of full mark (maximum bleach)'),
      damageThresholdJPerMm2: Fluence('Fluence where the coating is ablated to bare metal; above this the cell is over-burned'),
    },
    { description: 'Anodized aluminum. Depth is always zero.', additionalProperties: false },
  ),
)
export type BleachResponse = Static<typeof BleachResponse>

export const MaterialResponse = named(
  'MaterialResponse',
  Type.Union([CharResponse, MeltResponse, BleachResponse], { description: 'Response kind, tagged by `kind`.' }),
)
export type MaterialResponse = Static<typeof MaterialResponse>

export const FireRisk = named(
  'FireRisk',
  Type.Union(
    [
      Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal('fluence'), thresholdJPerMm2: Fluence('Flashpoint-style fluence threshold (thermal dose when a thermal model is set)') },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('temperature'),
          thresholdK: Positive('Bulk-temperature threshold (K): the preheat the thermal grid reports where a pass arrives; requires a peakTemperature thermal model (COD-258)'),
        },
        { additionalProperties: false },
      ),
    ],
    { description: 'Fire-risk verdict threshold. `temperature` (COD-258) compares the bulk temperature, not the sub-millisecond flash of a pass.' },
  ),
)
export type FireRisk = Static<typeof FireRisk>

export const ThermalModel = named(
  'ThermalModel',
  Type.Union(
    [
      Type.Object({ kind: Type.Literal('none') }, { additionalProperties: false }),
      Type.Object(
        {
          kind: Type.Literal('peakTemperature'),
          conductivityWPerMmK: Positive('Thermal conductivity (W/(mm·K))'),
          volumetricHeatCapacityJPerMm3K: Positive('Density × specific heat (J/(mm³·K))'),
          ambientK: Positive('Ambient / initial temperature (K)'),
          rampOnsetK: Positive(
            'Peak surface temperature where the response ramp starts (toneStart / frostStart / markStart) for a single raster pass along machine X at referenceSpeedMmPerS (K). Scales the flash term so fluence thresholds keep their meaning at the reference speed (contract thermal.ts).',
          ),
          referenceSpeedMmPerS: Positive('Speed the fluence thresholds were derived at (mm/s); the thermal dose equals fluence there'),
          absorptionAtFullChar: Type.Optional(Fraction('Absorption once fully charred (absorption feedback, char kind only)')),
        },
        { additionalProperties: false },
      ),
    ],
    {
      description:
        'Thermal step (COD-258). `none` drives the response from fluence. `peakTemperature` (Option B) runs a coarse thermal grid plus a per-pass flash term and drives the response from thermal dose (contract thermal.ts). A future speedCorrection variant (Option A) is additive.',
    },
  ),
)
export type ThermalModel = Static<typeof ThermalModel>

export const MaterialProfile = named(
  'MaterialProfile',
  Type.Object(
    {
      contractVersion: Type.Literal(CONTRACT_VERSION),
      id: Type.String({ description: 'Stable slug, e.g. "birch-ply-generic"', pattern: '^[a-z0-9][a-z0-9-]*$' }),
      name: Type.String({ minLength: 1 }),
      absorption: Fraction('Fraction of optical energy absorbed at 450 nm by fresh material (char feedback: thermal.absorptionAtFullChar)'),
      sigmaHeatMm: NonNegative('Heat-spread length added in quadrature to the spot sigma (mm)'),
      response: MaterialResponse,
      fireRisk: FireRisk,
      thermal: ThermalModel,
      provenance: Provenance,
    },
    { description: 'Material profile. One response kind per material.', additionalProperties: false },
  ),
)
export type MaterialProfile = Static<typeof MaterialProfile>

/** Verdict thresholds derived per kind (COD-250 burn-verdict overlay). */
export function verdictThresholds(response: MaterialResponse): { underBelow: number; overAbove: number } {
  switch (response.kind) {
    case 'char':
      return { underBelow: response.toneStartJPerMm2, overAbove: response.toneEndJPerMm2 }
    case 'melt':
      return { underBelow: response.frostStartJPerMm2, overAbove: response.removalThresholdJPerMm2 }
    case 'bleach':
      return { underBelow: response.markStartJPerMm2, overAbove: response.damageThresholdJPerMm2 }
  }
}

/** Ordering checks JSON Schema can't express. Returns problems; empty means valid. */
export function checkMaterialProfile(profile: MaterialProfile): string[] {
  const r = profile.response
  const problems: string[] = []
  const ordered = (label: string, ...values: number[]) => {
    for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]!) return problems.push(`${label} must be non-decreasing`)
  }
  switch (r.kind) {
    case 'char':
      ordered('toneStart <= toneEnd', r.toneStartJPerMm2, r.toneEndJPerMm2)
      ordered('toneStart <= ablationThreshold', r.toneStartJPerMm2, r.ablationThresholdJPerMm2)
      break
    case 'melt':
      ordered('frostStart <= frostFull <= removalThreshold', r.frostStartJPerMm2, r.frostFullJPerMm2, r.removalThresholdJPerMm2)
      break
    case 'bleach':
      ordered('markStart <= markFull <= damageThreshold', r.markStartJPerMm2, r.markFullJPerMm2, r.damageThresholdJPerMm2)
      break
  }
  if (profile.fireRisk.kind === 'temperature' && profile.thermal.kind !== 'peakTemperature')
    problems.push('fireRisk.kind = temperature requires thermal.kind = peakTemperature')
  if (profile.thermal.kind === 'peakTemperature') {
    const t = profile.thermal
    if (t.rampOnsetK <= t.ambientK) problems.push('thermal.rampOnsetK must be above thermal.ambientK')
    if (t.absorptionAtFullChar !== undefined && r.kind !== 'char') problems.push('thermal.absorptionAtFullChar applies to the char kind only')
    if (profile.fireRisk.kind === 'temperature' && profile.fireRisk.thresholdK <= t.ambientK)
      problems.push('fireRisk.thresholdK must be above thermal.ambientK')
  }
  return problems
}

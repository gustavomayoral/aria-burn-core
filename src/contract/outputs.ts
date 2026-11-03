// SPDX-License-Identifier: MIT
// Outputs (core-internal): colour, height and verdict images from one
// function over the fluence grid (COD-250), or over thermal dose (COD-258),
// plus the hover readout (COD-259).

import type { Lab } from './common.ts'
import type { FluenceGrid, GridSpec } from './deposit.ts'
import { verdictThresholds, type MaterialProfile } from './material.ts'

/** Verdict bucket per cell, stored as a Uint8Array. */
export const Verdict = {
  /** No meaningful exposure; drawn transparent in the overlay. */
  Untouched: 0,
  /** Exposed but below the kind's start threshold. */
  Under: 1,
  InRange: 2,
  /** Past the kind's top threshold (char ramp end, melt removal, bleach damage). */
  Over: 3,
  /** At or above the material's fire-risk threshold. Takes precedence over Over. */
  FireRisk: 4,
} as const
export type Verdict = (typeof Verdict)[keyof typeof Verdict]

/** Cells below this fraction of the under threshold count as untouched. */
export const UNTOUCHED_FRACTION = 0.05

export function classifyFluence(material: Pick<MaterialProfile, 'response' | 'fireRisk'>, fluenceJPerMm2: number): Verdict {
  const { underBelow, overAbove } = verdictThresholds(material.response)
  if (material.fireRisk.kind === 'fluence' && fluenceJPerMm2 >= material.fireRisk.thresholdJPerMm2) return Verdict.FireRisk
  if (fluenceJPerMm2 > overAbove) return Verdict.Over
  if (fluenceJPerMm2 >= underBelow) return Verdict.InRange
  if (fluenceJPerMm2 > UNTOUCHED_FRACTION * underBelow) return Verdict.Under
  return Verdict.Untouched
}

/** One tile's (or the whole job's) outputs; all images share the fluence grid. */
export interface SimOutputs extends GridSpec {
  fluence: FluenceGrid
  /** sRGB RGBA8, row-major, row 0 = min Y (flip for display). */
  color: Uint8ClampedArray
  /** Material removed (mm, >= 0). Zero for bleach. */
  depthMm: Float32Array
  verdict: Uint8Array
  /**
   * Thermal dose (J/mm²) that drove colour, depth and verdict when the material
   * has a peakTemperature thermal model (contract thermal.ts), else null.
   */
  dose: Float32Array | null
  /** Equivalent single-pass peak surface temperature (K), ambient + flashKPerJPerMm2 · dose; null without a thermal model. */
  peakTemperatureK: Float32Array | null
  /** Bulk temperature (K) at thermal-grid resolution: the hottest preheat a pass met here; null without a thermal model. */
  bulkTemperatureK: Float32Array | null
}

/** Everything the hover readout shows for one cell. */
export interface CellReadout {
  cellX: number
  cellY: number
  /** Cell centre, absolute mm. */
  xMm: number
  yMm: number
  fluenceJPerMm2: number
  depthMm: number
  color: Lab
  verdict: Verdict
  /** Thermal dose (J/mm²); null without a thermal model. */
  doseJPerMm2: number | null
  peakTemperatureK: number | null
  bulkTemperatureK: number | null
  /** Source lines whose samples contributed most energy to this cell, most first (may be empty). */
  lines: number[]
}

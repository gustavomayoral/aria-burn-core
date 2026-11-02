// SPDX-License-Identifier: MIT
// Raw published settings behind the provisional material thresholds (COD-266).
// SOURCES.md has the links; this file is the machine-checkable copy so COD-254
// can swap rows and recompute. Fluence is absorbed, matching deposit.ts.

import { interpolateCurve, type PowerCurvePoint } from '../../contract/index.ts'

export interface PublishedSetting {
  source: string
  /** Rated optical power of the source machine (W). */
  moduleW: number
  /** Power setting as a fraction of S max. */
  s: number
  speedMmPerS: number
  lineIntervalMm: number
  /** True when the source gave no line interval and 0.1 mm was assumed. */
  lineIntervalAssumed: boolean
}

const row = (source: string, moduleW: number, s: number, speedMmPerS: number, lineIntervalMm: number | null): PublishedSetting => ({
  source,
  moduleW,
  s,
  speedMmPerS,
  lineIntervalMm: lineIntervalMm ?? 0.1,
  lineIntervalAssumed: lineIntervalMm === null,
})

export const WOOD_SETTINGS: PublishedSetting[] = [
  row('lasergenerator 10 W basswood ply', 10, 0.4, 100, 0.1),
  row('lasergenerator 10 W birch ply', 10, 0.45, 100, 0.1),
  row('Koenig D1 Pro 10 W birch ply raster', 10, 0.8, 100, null),
  row('hobbyistlasercalc 10 W basswood', 10, 0.4, 3000 / 60, null),
  row('Koenig M1 10 W basswood bitmap', 10, 0.7, 175, null),
  row('bonnycreations 20 W official basswood', 20, 0.4, 100, null),
  row('bonnycreations 20 W community basswood', 20, 0.55, 3000 / 60, 0.1),
  row('bonnycreations 20 W community basswood fast', 20, 0.7, 4000 / 60, 0.1),
  row('bonnycreations 20 W community 9 mm birch', 20, 0.7, 3500 / 60, null),
]

export const ACRYLIC_SETTINGS: PublishedSetting[] = [
  row('lasergenerator 10 W black/opaque cast', 10, 0.3, 150, 0.1),
  row('hobbyistlasercalc 10 W cast acrylic', 10, 0.3, 4000 / 60, null),
  row('Koenig D1 Pro 10 W dark red opaque raster', 10, 0.8, 50, null),
  row('Koenig M1 10 W brown opaque fill', 10, 0.35, 130, null),
  row('Koenig M1 10 W dark red opaque bitmap', 10, 0.3, 100, null),
  row('bonnycreations 20 W community black acrylic', 20, 0.5, 4000 / 60, null),
]

export const ANODIZED_SETTINGS: PublishedSetting[] = [
  row('lasergenerator 10 W anodized', 10, 0.8, 60, 0.1),
  row('LightBurn forum 10 W (MikeyH)', 10, 0.3, 2500 / 60, 25.4 / 318),
  row('bonnycreations 20 W community 70-80 %', 20, 0.75, 1500 / 60, null),
  row('bonnycreations 20 W community 60-75 %', 20, 0.675, 2000 / 60, null),
  row('bonnycreations 20 W community 50 %', 20, 0.5, 1500 / 60, null),
  row('bonnycreations 20 W community xTool EasySet', 20, 1, 4000 / 60, 0.1),
]

/** F_abs = absorption · P · curve(S) / (v · line interval), in J/mm². */
export function absorbedFluence(setting: PublishedSetting, curve: readonly PowerCurvePoint[], absorption: number): number {
  const powerW = setting.moduleW * interpolateCurve(curve, setting.s)
  return (absorption * powerW) / (setting.speedMmPerS * setting.lineIntervalMm)
}

/** Threshold rule shared by all materials: start = min / 1.5, mid = median, over = max × 1.3. */
export function thresholdBand(fluences: readonly number[]): { start: number; mid: number; over: number } {
  const v = [...fluences].sort((a, b) => a - b)
  const n = v.length
  const mid = n % 2 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2
  return { start: v[0]! / 1.5, mid, over: v[n - 1]! * 1.3 }
}

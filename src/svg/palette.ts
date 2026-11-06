// SPDX-License-Identifier: MIT
// LightBurn's layer palette (BURN-50). LightBurn names its cut layers C00..C29
// and colours each from this fixed list; an SVG colour that matches one exactly
// lands on that layer. The tool layers T1/T2 are not matched: they never come
// from artwork colours.
//
// Values are LightBurn's default palette as published in its layer list; the
// LightBurn comparison fixture (BURN-56) checks them against a real export.

import { hexToRgb } from './style.ts'

export interface PaletteEntry {
  index: number
  /** C00, C01, … */
  name: string
  /** Lowercase #rrggbb. */
  color: string
}

const HEX = [
  '000000', '0000ff', 'ff0000', '00e000', 'd0d000', 'ff8000', '00e0e0', 'ff00ff', 'b4b4b4', '0000a0',
  'a00000', '00a000', 'a0a000', 'c08000', '00a0ff', 'a000a0', '808080', '7d87b9', 'bb7784', '4a6fe3',
  'd33f6a', '8cd78c', 'f0b98d', 'f6c4e1', 'fa9ed4', '500a78', 'b45a00', '004754', '86fa88', 'ffdb66',
]

export const LIGHTBURN_PALETTE: readonly PaletteEntry[] = HEX.map((h, index) => ({
  index,
  name: `C${String(index).padStart(2, '0')}`,
  color: `#${h}`,
}))

const BY_COLOR = new Map(LIGHTBURN_PALETTE.map((e) => [e.color, e]))

/** The palette entry with exactly this colour, if any. */
export function paletteMatch(hex: string): PaletteEntry | undefined {
  return BY_COLOR.get(hex.toLowerCase())
}

/**
 * The perceptually nearest palette entry, by the "redmean" weighted RGB
 * distance. Only used to note the closest LightBurn layer; the colour itself
 * stays its own layer.
 */
export function nearestPaletteEntry(hex: string): { entry: PaletteEntry; distance: number } {
  const [r1, g1, b1] = hexToRgb(hex)
  let best = LIGHTBURN_PALETTE[0]!
  let bestD = Infinity
  for (const e of LIGHTBURN_PALETTE) {
    const [r2, g2, b2] = hexToRgb(e.color)
    const rm = (r1 + r2) / 2
    const d = Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2)
    if (d < bestD) {
      bestD = d
      best = e
    }
  }
  return { entry: best, distance: bestD }
}

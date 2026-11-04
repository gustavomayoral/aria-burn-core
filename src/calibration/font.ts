// SPDX-License-Identifier: MIT
// A small single-stroke font for engraved labels. Glyphs are polylines on a
// 4 × 6 unit box (cap height 6, y up), drawn for this project: chamfered
// capitals and digits that stay legible at 2 mm with a 0.1 mm diode spot.

type Stroke = readonly (readonly [number, number])[]

const O: Stroke = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]
const P: Stroke = [[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]
const box = (x0: number, y0: number, s: number): Stroke => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]]

const GLYPHS: Record<string, readonly Stroke[]> = {
  '0': [O, [[0.6, 1.2], [3.4, 4.8]]],
  '1': [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
  '2': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [0, 0], [4, 0]]],
  '3': [[[0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1.5, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  '4': [[[3, 0], [3, 6], [0, 2], [4, 2]]],
  '5': [[[4, 6], [0, 6], [0, 3.5], [3, 3.5], [4, 2.5], [4, 1], [3, 0], [0, 0]]],
  '6': [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [0, 3.5]]],
  '7': [[[0, 6], [4, 6], [1.5, 0]]],
  '8': [[[1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  '9': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 3.5], [1, 2.5], [4, 2.5]]],
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 3], [4, 3]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  C: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 6], [0, 6], [0, 0], [4, 0]], [[0, 3], [3, 3]]],
  F: [[[4, 6], [0, 6], [0, 0]], [[0, 3], [3, 3]]],
  G: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 6], [3, 6]], [[2, 6], [2, 0]], [[1, 0], [3, 0]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  K: [[[0, 0], [0, 6]], [[4, 6], [0, 2]], [[1.4, 3.4], [4, 0]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  N: [[[0, 0], [0, 6], [4, 0], [4, 6]]],
  O: [O],
  P: [P],
  Q: [O, [[2.5, 1.5], [4, 0]]],
  R: [P, [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  T: [[[0, 6], [4, 6]], [[2, 6], [2, 0]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  W: [[[0, 6], [1, 0], [2, 4], [3, 0], [4, 6]]],
  X: [[[0, 0], [4, 6]], [[0, 6], [4, 0]]],
  Y: [[[0, 6], [2, 3], [4, 6]], [[2, 3], [2, 0]]],
  Z: [[[0, 6], [4, 6], [0, 0], [4, 0]]],
  '.': [box(1.5, 0, 0.8)],
  ':': [box(1.5, 0.6, 0.8), box(1.5, 4, 0.8)],
  '%': [[[0, 0], [4, 6]], box(0, 4.6, 1.2), box(2.8, 0.2, 1.2)],
  '-': [[[0.5, 3], [3.5, 3]]],
  '+': [[[0.5, 3], [3.5, 3]], [[2, 1.5], [2, 4.5]]],
  '=': [[[0.5, 2], [3.5, 2]], [[0.5, 4], [3.5, 4]]],
  '/': [[[0, 0], [4, 6]]],
  '°': [box(1, 4.4, 1.6)],
}

const ADVANCE = 5.2
const SPACE = 3

/** Characters the font draws (others are rejected, so a label never silently loses text). */
export const FONT_CHARS = Object.keys(GLYPHS).join('') + ' '

const glyphFor = (c: string) => GLYPHS[c] ?? GLYPHS[c.toUpperCase()]

/** Width of `text` at cap height `heightMm` (mm). */
export function textWidthMm(text: string, heightMm: number): number {
  const u = heightMm / 6
  let w = 0
  for (const c of text) w += c === ' ' ? SPACE : ADVANCE
  return Math.max(0, w - (ADVANCE - 4)) * u
}

/**
 * Polylines (mm) drawing `text` with its baseline-left corner at (x, y).
 * `align` places x at the start, middle or end of the text.
 */
export function textStrokes(text: string, xMm: number, yMm: number, heightMm: number, align: 'start' | 'middle' | 'end' = 'start'): [number, number][][] {
  const u = heightMm / 6
  const width = textWidthMm(text, heightMm)
  let x = align === 'start' ? xMm : align === 'middle' ? xMm - width / 2 : xMm - width
  const out: [number, number][][] = []
  for (const c of text) {
    if (c === ' ') {
      x += SPACE * u
      continue
    }
    const g = glyphFor(c)
    if (!g) throw new Error(`label font has no glyph for "${c}"`)
    for (const stroke of g) out.push(stroke.map(([gx, gy]) => [x + gx * u, yMm + gy * u]))
    x += ADVANCE * u
  }
  return out
}

// SPDX-License-Identifier: MIT
// SVG lengths, the document size in mm and the viewBox mapping (BURN-50).

import { multiply, scale, translate, type Matrix } from './matrix.ts'

export const MM_PER_IN = 25.4
/** CSS px: inside the drawing, absolute units always convert at 96 px per inch. */
export const CSS_PX_PER_IN = 96

export type LengthUnit = '' | 'px' | 'mm' | 'cm' | 'in' | 'pt' | 'pc' | '%' | 'em' | 'ex'

export interface Length {
  value: number
  unit: LengthUnit
}

export function parseLength(text: string | undefined): Length | null {
  if (text === undefined) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|mm|cm|in|pt|pc|%|em|ex)?\s*$/i.exec(text)
  if (!m) return null
  return { value: Number(m[1]), unit: (m[2]?.toLowerCase() ?? '') as LengthUnit }
}

/** mm per one of `unit`, with `pxPerInch` for px and unitless; null for relative units. */
export function mmPerUnit(unit: LengthUnit, pxPerInch: number): number | null {
  switch (unit) {
    case 'mm':
      return 1
    case 'cm':
      return 10
    case 'in':
      return MM_PER_IN
    case 'pt':
      return MM_PER_IN / 72
    case 'pc':
      return MM_PER_IN / 6
    case '':
    case 'px':
      return MM_PER_IN / pxPerInch
    default:
      return null
  }
}

/**
 * A length inside the drawing in user units. Absolute units convert at CSS's
 * 96 px/in (a user unit is a CSS px); `%` resolves against `reference`
 * (the viewport width, height or diagonal). Returns null for em/ex.
 */
export function userLength(len: Length, reference: number): number | null {
  if (len.unit === '%') return (len.value / 100) * reference
  const mm = mmPerUnit(len.unit, CSS_PX_PER_IN)
  if (mm === null) return null
  return len.unit === '' || len.unit === 'px' ? len.value : (len.value * mm * CSS_PX_PER_IN) / MM_PER_IN
}

export type ViewBox = readonly [number, number, number, number]

export function parseViewBox(text: string | undefined): ViewBox | null {
  if (text === undefined) return null
  const n = text
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || !(n[2]! > 0) || !(n[3]! > 0)) return null
  return n as unknown as ViewBox
}

/**
 * The viewBox → viewport transform (SVG 1.1 §7.8), for a viewport of `width`
 * × `height` in whatever units the caller wants out.
 */
export function viewBoxTransform(vb: ViewBox, width: number, height: number, preserveAspectRatio = 'xMidYMid meet'): Matrix {
  const [minX, minY, vw, vh] = vb
  const parts = preserveAspectRatio.trim().split(/\s+/)
  const align = parts[0] === 'defer' ? (parts[1] ?? 'xMidYMid') : (parts[0] ?? 'xMidYMid')
  const slice = parts.includes('slice')
  let sx = width / vw
  let sy = height / vh
  let tx = 0
  let ty = 0
  if (align !== 'none') {
    const s = slice ? Math.max(sx, sy) : Math.min(sx, sy)
    sx = sy = s
    const extraX = width - vw * s
    const extraY = height - vh * s
    if (align.includes('xMid')) tx = extraX / 2
    else if (align.includes('xMax')) tx = extraX
    if (align.includes('YMid')) ty = extraY / 2
    else if (align.includes('YMax')) ty = extraY
  }
  return multiply(translate(tx, ty), multiply(scale(sx, sy), translate(-minX, -minY)))
}

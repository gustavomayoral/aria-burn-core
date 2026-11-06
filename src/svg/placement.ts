// SPDX-License-Identifier: MIT
// Placing an imported SVG on the bed (BURN-51, feature BURN-49).
//
// readSvg (BURN-50) already gives bed-style mm: X right, Y up, origin at the
// bottom-left of the SVG page. Placement then scales (aspect locked) and
// rotates the design about its centre, and moves it so a 9-point anchor of
// its bounding box lands on bed X/Y, as in xTool Creative Space. The default
// (true size, no rotation, bottom-left at the bed origin) is the identity.
//
// The box is the SVG page by default, so a design keeps the margins it was
// drawn with; `reference: 'content'` uses the drawn geometry's bounds instead.
// After a rotation the anchor is on the axis-aligned box of the rotated page
// (or of the rotated geometry).

import type { BoundsMm } from '../contract/index.ts'
import { apply, multiply, rotate, scale, translate, type Matrix } from './matrix.ts'
import type { SvgDocument } from './read.ts'

export const ANCHORS = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const
export type Anchor = (typeof ANCHORS)[number]

export interface Placement {
  /** Bed X of the anchor (mm). */
  xMm: number
  /** Bed Y of the anchor (mm). */
  yMm: number
  anchor: Anchor
  /** Uniform scale; 1 is true size. */
  scale: number
  /** Counter-clockwise about the design's centre (deg). */
  rotationDeg: number
  /** The box the anchor and centre refer to. Default 'page'. */
  reference?: 'page' | 'content'
}

export const DEFAULT_PLACEMENT: Readonly<Placement> = Object.freeze({ xMm: 0, yMm: 0, anchor: 'bottom-left', scale: 1, rotationDeg: 0 })

/** The point of a box an anchor names. */
export function anchorPoint(b: BoundsMm, anchor: Anchor): { xMm: number; yMm: number } {
  const [v, h] = anchor === 'center' ? ['', ''] : anchor.includes('-') ? anchor.split('-') : ['top', 'bottom'].includes(anchor) ? [anchor, ''] : ['', anchor]
  const xMm = h === 'left' ? b.minXMm : h === 'right' ? b.maxXMm : (b.minXMm + b.maxXMm) / 2
  const yMm = v === 'bottom' ? b.minYMm : v === 'top' ? b.maxYMm : (b.minYMm + b.maxYMm) / 2
  return { xMm, yMm }
}

const emptyBounds = () => ({ minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity })

function grow(b: BoundsMm, x: number, y: number): void {
  if (x < b.minXMm) b.minXMm = x
  if (y < b.minYMm) b.minYMm = y
  if (x > b.maxXMm) b.maxXMm = x
  if (y > b.maxYMm) b.maxYMm = y
}

/**
 * Bounds of shapes after `m` (all of them, or the indices in `only`); null
 * when there are no points.
 */
export function transformedBounds(doc: SvgDocument, m: Matrix, only?: Iterable<number>): BoundsMm | null {
  const b = emptyBounds()
  const shapes = only ? [...only].map((i) => doc.shapes[i]!) : doc.shapes
  for (const s of shapes)
    for (const sp of s.subpaths) {
      const p = sp.points
      for (let i = 0; i < p.length; i += 2) {
        const [x, y] = apply(m, p[i]!, p[i + 1]!)
        grow(b, x, y)
      }
    }
  return Number.isFinite(b.minXMm) ? b : null
}

/** SVG mm (readSvg's frame) → bed mm for a placement. Throws RangeError on a bad scale or position. */
export function placementMatrix(doc: SvgDocument, placement: Placement): Matrix {
  const { scale: k, rotationDeg, xMm, yMm } = placement
  if (!(k > 0) || !Number.isFinite(k)) throw new RangeError(`placement scale must be a positive number, got ${k}`)
  if (![rotationDeg, xMm, yMm].every(Number.isFinite)) throw new RangeError('placement position and rotation must be finite')
  const content = placement.reference === 'content' && doc.bounds
  const box: BoundsMm = content ? doc.bounds! : { minXMm: 0, minYMm: 0, maxXMm: doc.widthMm, maxYMm: doc.heightMm }
  const cx = (box.minXMm + box.maxXMm) / 2
  const cy = (box.minYMm + box.maxYMm) / 2
  const local = multiply(translate(cx, cy), multiply(rotate(rotationDeg), multiply(scale(k), translate(-cx, -cy))))
  let placed: BoundsMm
  if (content) placed = transformedBounds(doc, local)!
  else {
    placed = emptyBounds()
    for (const [x, y] of [
      [box.minXMm, box.minYMm],
      [box.maxXMm, box.minYMm],
      [box.maxXMm, box.maxYMm],
      [box.minXMm, box.maxYMm],
    ] as const)
      grow(placed, ...apply(local, x, y))
  }
  const a = anchorPoint(placed, placement.anchor)
  return multiply(translate(xMm - a.xMm, yMm - a.yMm), local)
}

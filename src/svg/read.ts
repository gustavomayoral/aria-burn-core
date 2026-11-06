// SPDX-License-Identifier: MIT
// Reads an SVG into mm geometry and LightBurn-style colour layers (BURN-50).
//
// Output frame: millimetres, X right, Y up, origin at the bottom-left corner of
// the SVG's viewport (its width × height). The design loads at true size with
// that corner at the bed origin (BURN-49); placement (BURN-51/54) maps from here.
//
// Nothing is guessed: anything we cannot read is listed in `diagnostics`, once
// per kind, with how many times it occurred.

import { defaultLayerSettings, type BoundsMm, type LayerSettings } from '../contract/index.ts'
import { multiply, parseTransform, scale, translate, type Matrix } from './matrix.ts'
import { nearestPaletteEntry, paletteMatch, type PaletteEntry } from './palette.ts'
import {
  ellipseSubpath,
  flattenSubpath,
  parsePathData,
  polylineLength,
  polySubpath,
  rectSubpath,
  type Polyline,
  type RawSubpath,
} from './path.ts'
import {
  INITIAL_STYLE,
  computeStyle,
  elementDeclarations,
  parseStyleSheet,
  resolvePaint,
  type ComputedStyle,
  type StyleSheet,
} from './style.ts'
import { mmPerUnit, parseLength, parseViewBox, userLength, viewBoxTransform, type Length, type ViewBox } from './units.ts'
import { parseXml, textContent, type XmlElement } from './xml.ts'

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const DEFAULT_TOLERANCE_MM = 0.01
export const DEFAULT_PX_PER_INCH = 96

export interface ReadSvgOptions {
  /** px per inch for px and unitless document sizes. Default 96; Illustrator's older exports need 72. */
  pxPerInch?: number
  /** Maximum distance between a curve and its polyline, in mm. Default 0.01. */
  toleranceMm?: number
}

export type SvgDiagnosticCode =
  | 'px-size-assumed-dpi'
  | 'size-from-viewbox'
  | 'size-from-content'
  | 'unresolved-unit'
  | 'raster-image'
  | 'text-not-converted'
  | 'clip-path-ignored'
  | 'mask-ignored'
  | 'unsupported-element'
  | 'unsupported-css'
  | 'unsupported-paint'
  | 'unpainted-shape'
  | 'unresolved-reference'
  | 'invalid-path-data'
  | 'invalid-points'
  | 'invalid-transform'
  | 'unknown-entity'

export interface SvgDiagnostic {
  severity: 'warning' | 'error'
  code: SvgDiagnosticCode
  message: string
  /** How many times this occurred. */
  count: number
  /** The element, selector or value it concerns, when the code alone does not say. */
  subject?: string
}

export interface SvgSubpath extends Polyline {
  lengthMm: number
}

export interface SvgShape {
  /** Index in SvgDocument.shapes (document order). */
  index: number
  /** Source element name: path, rect, circle, … */
  element: string
  /** The element's id attribute, if any. */
  id?: string
  /** 1-based source line of the element. */
  line: number
  /** Stroke colour (#rrggbb), or null when not stroked. */
  stroke: string | null
  /** Fill colour (#rrggbb), or null when not filled. */
  fill: string | null
  fillRule: 'nonzero' | 'evenodd'
  subpaths: SvgSubpath[]
  lengthMm: number
  bounds: BoundsMm
}

export interface SvgLayer {
  /** C00..C29 for a LightBurn palette colour, else the colour's hex. */
  id: string
  name: string
  /** #rrggbb */
  color: string
  /** Set when the colour is exactly a LightBurn palette colour. */
  palette: PaletteEntry | null
  /** For a colour off the palette: the nearest palette entry, for reference only. */
  nearestPalette: PaletteEntry | null
  /** Indices into SvgDocument.shapes. A shape stroked in this colour and filled in another is on both layers. */
  shapes: number[]
  /** Shapes on this layer through their stroke. */
  strokeShapeCount: number
  /** Shapes on this layer through their fill. */
  fillShapeCount: number
  pathCount: number
  subpathCount: number
  lengthMm: number
  bounds: BoundsMm
  settings: LayerSettings
}

export interface SvgDocument {
  widthMm: number
  heightMm: number
  viewBox: ViewBox | null
  /** px per inch used for a px or unitless size. */
  pxPerInch: number
  toleranceMm: number
  shapes: SvgShape[]
  /** Palette layers in palette order, then other colours in order of first appearance. */
  layers: SvgLayer[]
  /** Bounds of all geometry, or null when there is none. */
  bounds: BoundsMm | null
  diagnostics: SvgDiagnostic[]
}

export class SvgReadError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message)
    this.name = 'SvgReadError'
  }
}

// Elements that never render on their own and are silently skipped where they stand.
const NON_RENDERING = new Set([
  'defs', 'symbol', 'clipPath', 'mask', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'filter',
  'style', 'title', 'desc', 'metadata', 'script', 'font', 'font-face', 'color-profile', 'cursor', 'view',
  'animate', 'animateMotion', 'animateTransform', 'set', 'mpath',
])
const CONTAINERS = new Set(['g', 'a', 'switch', 'svg'])
const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])

class Diagnostics {
  private readonly map = new Map<string, SvgDiagnostic>()
  add(code: SvgDiagnosticCode, message: string, subject?: string, severity: 'warning' | 'error' = 'warning') {
    const key = `${code}\u0000${subject ?? ''}`
    const d = this.map.get(key)
    if (d) d.count++
    else this.map.set(key, { severity, code, message, count: 1, ...(subject !== undefined ? { subject } : {}) })
  }
  list(): SvgDiagnostic[] {
    return [...this.map.values()]
  }
}

interface Context {
  matrix: Matrix
  style: ComputedStyle
  /** prefix → namespace URI in scope. */
  ns: Map<string, string>
  /** ids of `use` targets on the current chain, to stop reference cycles. */
  useChain: Set<string>
  /** Viewport of the nearest svg/symbol, in user units, for % lengths. */
  viewport: { w: number; h: number }
}

export function readSvg(source: string, options: ReadSvgOptions = {}): SvgDocument {
  const pxPerInch = options.pxPerInch ?? DEFAULT_PX_PER_INCH
  const tol = options.toleranceMm ?? DEFAULT_TOLERANCE_MM
  if (!(pxPerInch > 0)) throw new RangeError('pxPerInch must be > 0')
  if (!(tol > 0)) throw new RangeError('toleranceMm must be > 0')
  const diag = new Diagnostics()

  const { root, unknownEntities } = (() => {
    try {
      return parseXml(source)
    } catch (e) {
      const err = e as Error & { line?: number }
      throw new SvgReadError(`Not a readable SVG: ${err.message}`, err.line ?? 0)
    }
  })()
  for (const name of unknownEntities) diag.add('unknown-entity', `Undefined XML entity &${name}; left as written`, name)

  const rootNs = scopeNamespaces(new Map(), root)
  if (localName(root.name, rootNs) !== 'svg') throw new SvgReadError(`The root element is <${root.name}>, not <svg>`, root.line)

  // ids and style sheets, document-wide.
  const byId = new Map<string, XmlElement>()
  const sheet: StyleSheet = { rules: [], unsupported: [] }
  const index = (el: XmlElement, ns: Map<string, string>) => {
    const scope = scopeNamespaces(ns, el)
    const id = el.attributes.id
    if (id !== undefined && !byId.has(id)) byId.set(id, el)
    if (localName(el.name, scope) === 'style') parseStyleSheet(textContent(el), sheet)
    for (const c of el.children) if (c.type === 'element') index(c, scope)
  }
  index(root, new Map())
  for (const sel of sheet.unsupported)
    diag.add('unsupported-css', `CSS selector or rule not supported (only element, class and id selectors): ${sel}`, sel)

  // --- Document size ---
  const viewBox = parseViewBox(root.attributes.viewBox)
  const sizeMm = (attr: 'width' | 'height'): { mm: number | null; user: number | null; px: boolean } => {
    const raw = root.attributes[attr]
    const len = parseLength(raw)
    if (raw === undefined || len === null) {
      if (raw !== undefined) diag.add('unresolved-unit', `Root ${attr}="${raw}" cannot be read`, `svg ${attr}`)
      return { mm: null, user: null, px: false }
    }
    if (len.unit === '%') return { mm: null, user: null, px: false }
    const k = mmPerUnit(len.unit, pxPerInch)
    if (k === null) {
      diag.add('unresolved-unit', `Root ${attr}="${raw}" uses a relative unit and cannot be sized`, `svg ${attr}`)
      return { mm: null, user: null, px: false }
    }
    const px = len.unit === '' || len.unit === 'px'
    return { mm: len.value * k, user: px ? len.value : userLength(len, 0), px }
  }
  const w = sizeMm('width')
  const h = sizeMm('height')
  if (w.px || h.px) {
    diag.add(
      'px-size-assumed-dpi',
      `The document size is in px or has no unit; read at ${pxPerInch} px per inch` +
        (pxPerInch === 96 ? ' (re-read at 72 for files from older Illustrator versions)' : ''),
    )
  }

  let widthMm = w.mm
  let heightMm = h.mm
  // Only one dimension: derive the other from the viewBox aspect.
  if (viewBox && widthMm !== null && heightMm === null) heightMm = (widthMm * viewBox[3]) / viewBox[2]
  if (viewBox && heightMm !== null && widthMm === null) widthMm = (heightMm * viewBox[2]) / viewBox[3]
  if (viewBox && widthMm === null && heightMm === null) {
    widthMm = (viewBox[2] * 25.4) / pxPerInch
    heightMm = (viewBox[3] * 25.4) / pxPerInch
    diag.add('size-from-viewbox', `No usable width/height; sized from the viewBox at ${pxPerInch} px per inch`)
  }

  // User units → document mm (still y down).
  let toDoc: Matrix
  let viewport: { w: number; h: number }
  let sizedFromContent = false
  if (viewBox) {
    toDoc = viewBoxTransform(viewBox, widthMm!, heightMm!, root.attributes.preserveAspectRatio)
    viewport = { w: viewBox[2], h: viewBox[3] }
  } else if (widthMm !== null && heightMm !== null) {
    // No viewBox: a user unit is a px; with a px/unitless size that px is the document's, at pxPerInch.
    const k = w.px || h.px ? 25.4 / pxPerInch : 25.4 / 96
    toDoc = scale(k)
    viewport = { w: widthMm / k, h: heightMm / k }
  } else {
    // Neither a size nor a viewBox: user units as px at pxPerInch, size from the content.
    const k = 25.4 / pxPerInch
    toDoc = scale(k)
    viewport = { w: 0, h: 0 }
    sizedFromContent = true
  }

  // --- Walk ---
  interface Pending {
    el: XmlElement
    tag: string
    style: ComputedStyle
    subpaths: RawSubpath[]
    matrix: Matrix
  }
  const pending: Pending[] = []

  const lengthAttr = (el: XmlElement, name: string, ref: number, fallback: number | null = 0): number | null => {
    const raw = el.attributes[name]
    if (raw === undefined) return fallback
    if (raw.trim() === 'auto') return null
    const len: Length | null = parseLength(raw)
    if (!len) {
      diag.add('unresolved-unit', `<${el.name} ${name}="${raw}"> cannot be read`, `${el.name} ${name}`)
      return fallback
    }
    const v = userLength(len, ref)
    if (v === null) {
      diag.add('unresolved-unit', `<${el.name} ${name}="${raw}"> uses ${len.unit}, which needs font metrics`, `${el.name} ${name}`)
      return fallback
    }
    return v
  }

  const elementMatrix = (el: XmlElement, parent: Matrix): Matrix => {
    const t = el.attributes.transform
    if (t === undefined) return parent
    const m = parseTransform(t)
    if (!m) {
      diag.add('invalid-transform', `transform="${t}" is malformed; the element is drawn untransformed`, el.name)
      return parent
    }
    return multiply(parent, m)
  }

  const walk = (el: XmlElement, parent: Context, isRoot = false): void => {
    const ns = scopeNamespaces(parent.ns, el)
    const tag = localName(el.name, ns)
    if (tag === null) return // foreign namespace (Inkscape, sodipodi, …)
    if (NON_RENDERING.has(tag)) return
    if (tag === 'image') return void diag.add('raster-image', 'Raster <image> elements are not imported')
    if (tag === 'text') return void diag.add('text-not-converted', '<text> is not imported; convert text to paths first')
    if (tag === 'foreignObject' || (!CONTAINERS.has(tag) && !SHAPES.has(tag) && tag !== 'use')) {
      return void diag.add('unsupported-element', `<${tag}> is not supported and was skipped`, tag)
    }

    const style = computeStyle(parent.style, elementDeclarations(el, tag, sheet))
    if (style.display === 'none') return
    if (style.clipPath) diag.add('clip-path-ignored', 'Clip paths are ignored; clipped shapes are imported whole')
    if (style.mask) diag.add('mask-ignored', 'Masks are ignored; masked shapes are imported whole')

    let matrix = elementMatrix(el, parent.matrix)
    let viewport = parent.viewport

    if (tag === 'svg' && !isRoot) {
      // Nested viewport: x/y offset, then its own viewBox into its width × height.
      const x = lengthAttr(el, 'x', parent.viewport.w) ?? 0
      const y = lengthAttr(el, 'y', parent.viewport.h) ?? 0
      const vw = lengthAttr(el, 'width', parent.viewport.w, null) ?? parent.viewport.w
      const vh = lengthAttr(el, 'height', parent.viewport.h, null) ?? parent.viewport.h
      matrix = multiply(matrix, translate(x, y))
      const vb = parseViewBox(el.attributes.viewBox)
      if (vb) {
        matrix = multiply(matrix, viewBoxTransform(vb, vw, vh, el.attributes.preserveAspectRatio))
        viewport = { w: vb[2], h: vb[3] }
      } else viewport = { w: vw, h: vh }
    }

    const ctx: Context = { matrix, style, ns, useChain: parent.useChain, viewport }

    if (CONTAINERS.has(tag)) {
      for (const c of el.children) if (c.type === 'element') walk(c, ctx)
      return
    }
    if (tag === 'use') return walkUse(el, ctx)

    const subpaths = shapeSubpaths(el, tag, viewport)
    if (!subpaths.length) return
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return
    pending.push({ el, tag, style, subpaths, matrix })
  }

  const walkUse = (el: XmlElement, ctx: Context) => {
    const href = el.attributes.href ?? Object.entries(el.attributes).find(([k]) => k.endsWith(':href'))?.[1]
    const id = href?.trim().startsWith('#') ? href.trim().slice(1) : null
    const target = id !== null ? byId.get(id) : undefined
    if (!target || id === null) {
      diag.add('unresolved-reference', `<use> refers to ${href ?? 'nothing'}, which is not in this file`, href ?? '')
      return
    }
    if (ctx.useChain.has(id)) {
      diag.add('unresolved-reference', `<use> of #${id} refers back to itself`, `#${id}`)
      return
    }
    const x = lengthAttr(el, 'x', ctx.viewport.w) ?? 0
    const y = lengthAttr(el, 'y', ctx.viewport.h) ?? 0
    const chain = new Set(ctx.useChain).add(id)
    const base: Context = { ...ctx, matrix: multiply(ctx.matrix, translate(x, y)), useChain: chain }
    const targetNs = scopeNamespaces(ctx.ns, target)
    if (localName(target.name, targetNs) === 'symbol') {
      // A symbol is a viewport: its viewBox maps into the use's width × height (default 100%).
      const sStyle = computeStyle(base.style, elementDeclarations(target, 'symbol', sheet))
      if (sStyle.display === 'none') return
      let m = base.matrix
      let viewport = base.viewport
      const vb = parseViewBox(target.attributes.viewBox)
      if (vb) {
        const vw = lengthAttr(el, 'width', ctx.viewport.w, null) ?? lengthAttr(target, 'width', ctx.viewport.w, null) ?? ctx.viewport.w
        const vh = lengthAttr(el, 'height', ctx.viewport.h, null) ?? lengthAttr(target, 'height', ctx.viewport.h, null) ?? ctx.viewport.h
        m = multiply(m, viewBoxTransform(vb, vw, vh, target.attributes.preserveAspectRatio))
        viewport = { w: vb[2], h: vb[3] }
      }
      const sCtx: Context = { ...base, matrix: m, style: sStyle, ns: targetNs, viewport }
      for (const c of target.children) if (c.type === 'element') walk(c, sCtx)
      return
    }
    walk(target, base)
  }

  const shapeSubpaths = (el: XmlElement, tag: string, vp: { w: number; h: number }): RawSubpath[] => {
    const diagRef = Math.sqrt((vp.w * vp.w + vp.h * vp.h) / 2)
    const L = (name: string, ref: number) => lengthAttr(el, name, ref) ?? 0
    const one = (s: RawSubpath | null) => (s ? [s] : [])
    switch (tag) {
      case 'path': {
        const parsed = parsePathData(el.attributes.d ?? '')
        if (parsed.error) diag.add('invalid-path-data', `Path data error (${parsed.error}); the path is kept up to the error`)
        return parsed.subpaths
      }
      case 'rect':
        return one(
          rectSubpath(
            L('x', vp.w),
            L('y', vp.h),
            L('width', vp.w),
            L('height', vp.h),
            lengthAttr(el, 'rx', vp.w, null),
            lengthAttr(el, 'ry', vp.h, null),
          ),
        )
      case 'circle': {
        const r = L('r', diagRef)
        return one(ellipseSubpath(L('cx', vp.w), L('cy', vp.h), r, r))
      }
      case 'ellipse': {
        const rx = lengthAttr(el, 'rx', vp.w, null)
        const ry = lengthAttr(el, 'ry', vp.h, null)
        return one(ellipseSubpath(L('cx', vp.w), L('cy', vp.h), rx ?? ry ?? 0, ry ?? rx ?? 0))
      }
      case 'line':
        return one(polySubpath([L('x1', vp.w), L('y1', vp.h), L('x2', vp.w), L('y2', vp.h)], false))
      default: {
        // polyline / polygon
        const nums = (el.attributes.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
        const bad = nums.findIndex((n) => !Number.isFinite(n))
        let pts = bad >= 0 ? nums.slice(0, bad) : nums
        if (bad >= 0 || pts.length % 2) {
          diag.add('invalid-points', `<${tag}> has a malformed points list; the points up to the error are kept`)
          pts = pts.slice(0, pts.length - (pts.length % 2))
        }
        return one(polySubpath(pts, tag === 'polygon'))
      }
    }
  }

  walk(root, { matrix: toDoc, style: INITIAL_STYLE, ns: rootNs, useChain: new Set(), viewport }, true)

  // --- Flatten (in document mm, y down), then size from content if needed, then flip to y up ---
  interface Flat {
    p: Pending
    stroke: string | null
    fill: string | null
    polylines: Polyline[]
  }
  const flats: Flat[] = []
  for (const p of pending) {
    const paint = (value: string, what: 'stroke' | 'fill'): string | null => {
      const r = resolvePaint(value, p.style.color)
      if (r.kind === 'color') return r.hex
      if (r.kind === 'unsupported') diag.add('unsupported-paint', `${what}="${r.value}" is not a plain colour; treated as none`, r.value)
      return null
    }
    const stroke = paint(p.style.stroke, 'stroke')
    // A line has no interior, so its fill paints nothing.
    const fill = p.tag === 'line' ? null : paint(p.style.fill, 'fill')
    if (stroke === null && fill === null) {
      diag.add('unpainted-shape', 'Shapes with neither stroke nor fill are not imported')
      continue
    }
    const polylines = p.subpaths.map((s) => flattenSubpath(s, p.matrix, tol)).filter((x): x is Polyline => x !== null)
    if (polylines.length) flats.push({ p, stroke, fill, polylines })
  }

  if (sizedFromContent) {
    let maxX = 0
    let maxY = 0
    for (const f of flats)
      for (const pl of f.polylines)
        for (let i = 0; i < pl.points.length; i += 2) {
          maxX = Math.max(maxX, pl.points[i]!)
          maxY = Math.max(maxY, pl.points[i + 1]!)
        }
    widthMm = maxX
    heightMm = maxY
    diag.add('size-from-content', `No width, height or viewBox; sized from the drawing's extent at ${pxPerInch} px per inch`)
  }
  const H = heightMm ?? 0

  const shapes: SvgShape[] = flats.map((f, index) => {
    const subpaths: SvgSubpath[] = f.polylines.map((pl) => {
      for (let i = 1; i < pl.points.length; i += 2) pl.points[i] = H - pl.points[i]!
      return { ...pl, lengthMm: polylineLength(pl) }
    })
    const shape: SvgShape = {
      index,
      element: f.p.tag,
      line: f.p.el.line,
      stroke: f.stroke,
      fill: f.fill,
      fillRule: f.p.style.fillRule.trim() === 'evenodd' ? 'evenodd' : 'nonzero',
      subpaths,
      lengthMm: subpaths.reduce((s, sp) => s + sp.lengthMm, 0),
      bounds: boundsOf(subpaths)!,
    }
    if (f.p.el.attributes.id !== undefined) shape.id = f.p.el.attributes.id
    return shape
  })

  return {
    widthMm: widthMm ?? 0,
    heightMm: H,
    viewBox,
    pxPerInch,
    toleranceMm: tol,
    shapes,
    layers: buildLayers(shapes),
    bounds: unionBounds(shapes.map((s) => s.bounds)),
    diagnostics: diag.list(),
  }
}

/** Groups shapes into one layer per colour: by stroke colour, and by fill colour for filled shapes. */
export function buildLayers(shapes: readonly SvgShape[]): SvgLayer[] {
  const byColor = new Map<string, { shapes: Set<number>; stroke: number; fill: number; order: number }>()
  const touch = (color: string, shape: number, via: 'stroke' | 'fill') => {
    let l = byColor.get(color)
    if (!l) {
      l = { shapes: new Set(), stroke: 0, fill: 0, order: byColor.size }
      byColor.set(color, l)
    }
    if (via === 'stroke') l.stroke++
    else l.fill++
    l.shapes.add(shape)
  }
  for (const s of shapes) {
    if (s.stroke) touch(s.stroke, s.index, 'stroke')
    if (s.fill) touch(s.fill, s.index, 'fill')
  }
  const layers: (SvgLayer & { order: number })[] = []
  for (const [color, l] of byColor) {
    const palette = paletteMatch(color) ?? null
    const members = [...l.shapes].sort((a, b) => a - b).map((i) => shapes[i]!)
    layers.push({
      id: palette ? palette.name : color,
      name: palette ? palette.name : color,
      color,
      palette,
      nearestPalette: palette ? null : nearestPaletteEntry(color).entry,
      shapes: members.map((s) => s.index),
      strokeShapeCount: l.stroke,
      fillShapeCount: l.fill,
      pathCount: members.length,
      subpathCount: members.reduce((n, s) => n + s.subpaths.length, 0),
      lengthMm: members.reduce((n, s) => n + s.lengthMm, 0),
      bounds: unionBounds(members.map((s) => s.bounds))!,
      settings: defaultLayerSettings(l.stroke > 0 ? 'line' : 'fill'),
      order: l.order,
    })
  }
  layers.sort((a, b) => {
    const pa = a.palette?.index ?? Infinity
    const pb = b.palette?.index ?? Infinity
    return pa !== pb ? pa - pb : a.order - b.order
  })
  return layers.map(({ order: _order, ...layer }) => layer)
}

function boundsOf(subpaths: readonly Polyline[]): BoundsMm | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const s of subpaths)
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i]!
      const y = s.points[i + 1]!
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  return minX <= maxX ? { minXMm: minX, minYMm: minY, maxXMm: maxX, maxYMm: maxY } : null
}

function unionBounds(list: readonly BoundsMm[]): BoundsMm | null {
  if (!list.length) return null
  return list.reduce((a, b) => ({
    minXMm: Math.min(a.minXMm, b.minXMm),
    minYMm: Math.min(a.minYMm, b.minYMm),
    maxXMm: Math.max(a.maxXMm, b.maxXMm),
    maxYMm: Math.max(a.maxYMm, b.maxYMm),
  }))
}

/** Adds an element's xmlns declarations to the scope (copy-on-write). */
function scopeNamespaces(parent: Map<string, string>, el: XmlElement): Map<string, string> {
  let out = parent
  for (const [k, v] of Object.entries(el.attributes)) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) {
      if (out === parent) out = new Map(parent)
      out.set(k === 'xmlns' ? '' : k.slice(6), v)
    }
  }
  return out
}

/**
 * The SVG local name of an element, or null when it is in another namespace.
 * Unprefixed names are SVG unless a non-SVG default namespace is declared
 * (files without any xmlns are common and read as SVG).
 */
function localName(name: string, ns: Map<string, string>): string | null {
  const i = name.indexOf(':')
  if (i < 0) {
    const def = ns.get('')
    return def === undefined || def === SVG_NS ? name : null
  }
  return ns.get(name.slice(0, i)) === SVG_NS ? name.slice(i + 1) : null
}

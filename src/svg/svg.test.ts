// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LayerSettings, validate } from '../contract/index.ts'
import {
  LIGHTBURN_PALETTE,
  SvgReadError,
  defaultLayerSettings,
  nearestPaletteEntry,
  paletteMatch,
  parseColor,
  parsePathData,
  parseTransform,
  parseXml,
  readSvg,
  type SvgDocument,
  type SvgShape,
} from './index.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const read = (name: string, options = {}) => readSvg(fixture(name), options)

const svg = (attrs: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`

const byId = (doc: SvgDocument, id: string): SvgShape => {
  const s = doc.shapes.find((x) => x.id === id)
  if (!s) throw new Error(`no shape #${id}`)
  return s
}
const layer = (doc: SvgDocument, id: string) => {
  const l = doc.layers.find((x) => x.id === id)
  if (!l) throw new Error(`no layer ${id}; have ${doc.layers.map((x) => x.id).join(', ')}`)
  return l
}
const points = (s: SvgShape, sub = 0): [number, number][] => {
  const p = s.subpaths[sub]!.points
  const out: [number, number][] = []
  for (let i = 0; i < p.length; i += 2) out.push([p[i]!, p[i + 1]!])
  return out
}
const codes = (doc: SvgDocument) => Object.fromEntries(doc.diagnostics.map((d) => [d.subject ? `${d.code}:${d.subject}` : d.code, d.count]))

/**
 * A flattened curve is an inscribed polyline: never longer than the curve, and
 * shorter by at most about tol / r of its length (sagitta tol on radius r).
 */
const expectFlattenedLength = (actual: number, exact: number, minRadius: number, tol = 0.01) => {
  expect(actual).toBeLessThanOrEqual(exact + 1e-9)
  expect(actual).toBeGreaterThanOrEqual(exact * (1 - tol / minRadius))
}

/** Largest distance from the circle of any vertex or segment midpoint (the polyline's worst deviation). */
const circleDeviation = (s: SvgShape, cx: number, cy: number, r: number) => {
  const pts = points(s)
  let worst = 0
  pts.forEach(([x, y], i) => {
    const [nx, ny] = pts[(i + 1) % pts.length]!
    worst = Math.max(worst, Math.abs(Math.hypot(x - cx, y - cy) - r), Math.abs(Math.hypot((x + nx) / 2 - cx, (y + ny) / 2 - cy) - r))
  })
  return worst
}

describe('XML parser', () => {
  it('reads elements, attributes, entities, CDATA and skips comments and PIs', () => {
    const { root } = parseXml(
      `<?xml version="1.0"?><!-- c --><a x='1' y="&lt;&amp;&#65;&#x42;"><b/><![CDATA[<raw>]]>t&gt;<?pi x?><c></c></a>`,
    )
    expect(root.name).toBe('a')
    expect(root.attributes).toEqual({ x: '1', y: '<&AB' })
    expect(root.children.map((c) => (c.type === 'element' ? c.name : c.text))).toEqual(['b', '<raw>t>', 'c'])
  })

  it('honours internal-subset ENTITY declarations and reports unknown entities', () => {
    const r = parseXml(`<!DOCTYPE svg [ <!ENTITY ns "http://x"> ]><svg a="&ns;" b="&nope;"/>`)
    expect(r.root.attributes.a).toBe('http://x')
    expect(r.root.attributes.b).toBe('&nope;')
    expect(r.unknownEntities).toEqual(['nope'])
  })

  it('rejects malformed XML with the line', () => {
    expect(() => parseXml('<a>\n<b>\n</a>')).toThrow(/line 3/)
    expect(() => readSvg('<svg><g></svg>')).toThrow(SvgReadError)
    expect(() => readSvg('<html/>')).toThrow(/not <svg>/)
  })
})

describe('transforms, path data, colours', () => {
  it('parses transform lists in order', () => {
    expect(parseTransform('translate(10) scale(2,3)')).toEqual([2, 0, 0, 3, 10, 0])
    const r = parseTransform('rotate(90 10 10)')!
    expect(r.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, -1, 0, 20, 0])
    expect(parseTransform('translate(1,2) bogus(3)')).toBeNull()
  })

  it('reads every path command, implicit repeats and compact numbers', () => {
    const p = parsePathData('M0,0 10,0 l0,10 h-5 v-5 H0 V0 Z m1.5.5 c1,1 2,2 3,3 s1,1 2,2 q1,1 2,2 t2,2 a1,1 0 0,1 2,0 z')
    expect(p.error).toBeNull()
    expect(p.subpaths).toHaveLength(2)
    expect(p.subpaths[0]!.closed).toBe(true)
    expect(p.subpaths[1]!.x0).toBe(1.5)
    expect(p.subpaths[1]!.y0).toBe(0.5)
    expect(p.subpaths[1]!.segments.map((s) => s.kind)).toEqual(['cubic', 'cubic', 'cubic', 'cubic', 'arc', 'line'])
  })

  it('keeps a path up to a data error', () => {
    const p = parsePathData('M0,0 L10,0 L oops')
    expect(p.error).toMatch(/argument/)
    expect(p.subpaths[0]!.segments).toHaveLength(1)
  })

  it('parses colour syntaxes to #rrggbb', () => {
    for (const c of ['#ff0000', '#FF0000', '#f00', 'rgb(255,0,0)', 'rgb(100%, 0%, 0%)', 'red', '#ff0000cc']) expect(parseColor(c)).toBe('#ff0000')
    expect(parseColor('notacolor')).toBeNull()
  })
})

describe('LightBurn palette', () => {
  it('names C00..C29 and matches exact colours only', () => {
    expect(LIGHTBURN_PALETTE).toHaveLength(30)
    expect(paletteMatch('#000000')?.name).toBe('C00')
    expect(paletteMatch('#0000FF')?.name).toBe('C01')
    expect(paletteMatch('#ff0000')?.name).toBe('C02')
    expect(paletteMatch('#ffdb66')?.name).toBe('C29')
    expect(paletteMatch('#0000fe')).toBeUndefined()
    expect(nearestPaletteEntry('#0000fe').entry.name).toBe('C01')
    expect(nearestPaletteEntry('#010101').entry.name).toBe('C00')
  })
})

describe('document size in mm', () => {
  it('reads mm, cm, in, pt and pc sizes', () => {
    const size = (w: string) => readSvg(svg(`width="${w}" height="${w}" viewBox="0 0 10 10"`, '')).widthMm
    expect(size('10mm')).toBeCloseTo(10)
    expect(size('1cm')).toBeCloseTo(10)
    expect(size('1in')).toBeCloseTo(25.4)
    expect(size('72pt')).toBeCloseTo(25.4)
    expect(size('6pc')).toBeCloseTo(25.4)
  })

  it('reads px and unitless at 96 DPI with a warning, or at the DPI asked for', () => {
    const d96 = read('illustrator-px72.svg')
    expect(d96.widthMm).toBeCloseTo(38.1)
    expect(d96.pxPerInch).toBe(96)
    expect(d96.diagnostics.map((d) => d.code)).toEqual(['px-size-assumed-dpi'])
    expect(d96.diagnostics[0]!.message).toMatch(/96 px per inch/)

    const d72 = read('illustrator-px72.svg', { pxPerInch: 72 })
    expect(d72.widthMm).toBeCloseTo(50.8)
    expect(d72.heightMm).toBeCloseTo(25.4)
    expect(d72.shapes[0]!.lengthMm).toBeCloseTo(50.8)
    expect(layer(d72, 'C02').pathCount).toBe(1)
  })

  it('falls back to the viewBox at 96 DPI, with a warning', () => {
    const d = readSvg(svg('viewBox="0 0 96 48"', '<path d="M0,0 H96" stroke="#000"/>'))
    expect(d.widthMm).toBeCloseTo(25.4)
    expect(d.heightMm).toBeCloseTo(12.7)
    expect(codes(d)).toEqual({ 'size-from-viewbox': 1 })
    expect(d.shapes[0]!.lengthMm).toBeCloseTo(25.4)
  })

  it('derives a missing dimension from the viewBox aspect', () => {
    const d = readSvg(svg('width="100mm" viewBox="0 0 200 100"', ''))
    expect(d.heightMm).toBeCloseTo(50)
    expect(d.diagnostics).toEqual([])
  })

  it('sizes from the content when there is no size and no viewBox', () => {
    const d = readSvg(svg('', '<path d="M0,0 H96 V48" stroke="#000"/>'))
    expect(d.widthMm).toBeCloseTo(25.4)
    expect(d.heightMm).toBeCloseTo(12.7)
    expect(codes(d)).toHaveProperty('size-from-content', 1)
  })

  it('applies preserveAspectRatio', () => {
    const first = (par: string) => {
      const d = readSvg(svg(`width="100mm" height="50mm" viewBox="0 0 10 10" preserveAspectRatio="${par}"`, '<path d="M0,0 L10,10" stroke="#000"/>'))
      return points(d.shapes[0]!)
    }
    // meet: scale 5, centred horizontally (x + 25); y up from the bottom edge.
    expect(first('xMidYMid meet')[0]).toEqual([25, 50])
    expect(first('xMidYMid meet')[1]).toEqual([75, 0])
    // none: x × 10, y × 5.
    expect(first('none')[1]).toEqual([100, 0])
    // slice, bottom-aligned: scale 10, shifted up by 50.
    expect(first('xMinYMax slice')[0]).toEqual([0, 100])
  })
})

describe('Aria Studio laser exports', () => {
  it('reads the real export (stroked paths) into C00, C01 and the C29 frame', () => {
    const d = read('aria-studio-laser.svg')
    expect(d.widthMm).toBeCloseTo(215.9)
    expect(d.heightMm).toBeCloseTo(279.4)
    expect(d.diagnostics).toEqual([])
    expect(d.layers.map((l) => l.id)).toEqual(['C00', 'C01', 'C29'])
    const c00 = layer(d, 'C00')
    expect(c00.pathCount).toBe(2)
    expect(c00.lengthMm).toBeCloseTo(300 + 2 * Math.PI * 20, 1)
    // The 100 × 50 rectangle's top-left is (40, 60) from the page top; y up from the bottom edge.
    expect(d.shapes[0]!.bounds).toEqual({ minXMm: 40, minYMm: 279.4 - 110, maxXMm: 140, maxYMm: 279.4 - 60 })
    const c01 = layer(d, 'C01')
    expect(c01.pathCount).toBe(9)
    expect(c01.lengthMm).toBeCloseTo(900, 6)
    expect(c01.bounds.minYMm).toBeCloseTo(279.4 - 170)
    expect(layer(d, 'C29').bounds).toEqual({ minXMm: 0, minYMm: 0, maxXMm: 215.9, maxYMm: 279.4 })
    for (const l of d.layers) expect(l.settings.mode).toBe('line')
    // The Bézier circle stays within tolerance of the true circle (plus the 4-cubic approximation's own 0.027 %).
    expect(circleDeviation(d.shapes[1]!, 170, 279.4 - 85, 20)).toBeLessThan(0.01 + 20 * 0.00028)
  })

  it('inherits stroke from layer groups inside a translated canvas group', () => {
    const d = read('aria-studio-grouped.svg')
    expect(d.diagnostics).toEqual([])
    expect(d.layers.map((l) => [l.id, l.pathCount])).toEqual([
      ['C00', 2],
      ['C01', 3],
    ])
    expect(d.shapes[0]!.bounds).toEqual(read('aria-studio-laser.svg').shapes[0]!.bounds)
    expect(circleDeviation(d.shapes[1]!, 170, 279.4 - 85, 20)).toBeLessThan(0.01)
    expect(layer(d, 'C01').lengthMm).toBeCloseTo(300, 6)
  })
})

describe('editor files', () => {
  it('reads an Inkscape mm file: layer translate, inline styles, svg: prefix, editor metadata skipped', () => {
    const d = read('inkscape-mm.svg')
    expect(d.widthMm).toBe(100)
    expect(d.heightMm).toBe(80)
    expect(d.diagnostics).toEqual([])
    expect(d.layers.map((l) => [l.id, l.pathCount, l.settings.mode])).toEqual([
      ['C02', 2, 'line'],
      ['C03', 1, 'fill'],
    ])
    expect(byId(d, 'rect1').bounds).toEqual({ minXMm: 10, minYMm: 40, maxXMm: 50, maxYMm: 70 })
    const curve = byId(d, 'path1')
    expect(curve.subpaths[0]!.closed).toBe(false)
    const pts = points(curve)
    expect(pts[0]).toEqual([60, 65])
    expect(pts[pts.length - 1]![0]).toBeCloseTo(60)
    expect(pts[pts.length - 1]![1]).toBeCloseTo(25)
    expect(byId(d, 'path2').fill).toBe('#00e000')
  })

  it('reads an Illustrator pt file with a DOCTYPE, entity namespaces and a class style sheet', () => {
    const d = read('illustrator-pt.svg')
    expect(d.widthMm).toBeCloseTo(50.8)
    expect(d.heightMm).toBeCloseTo(25.4)
    expect(d.diagnostics).toEqual([])
    const k = 25.4 / 72
    const rect = d.shapes[0]!
    expect(rect.stroke).toBe('#000000')
    expect(rect.fill).toBeNull()
    expect(rect.bounds.minXMm).toBeCloseTo(9 * k)
    expect(rect.bounds.maxXMm).toBeCloseTo(63 * k)
    expect(d.layers.map((l) => [l.id, l.settings.mode])).toEqual([
      ['C00', 'line'],
      ['C01', 'fill'],
    ])
    expect(d.shapes[1]!.subpaths[0]!.closed).toBe(true)
  })
})

describe('geometry', () => {
  it('flattens nested transforms', () => {
    const d = read('nested-transforms.svg')
    const sq = points(byId(d, 'sq'))
    expect(sq[0]![0]).toBeCloseTo(50)
    expect(sq[0]![1]).toBeCloseTo(100 - 60)
    expect(sq[1]![0]).toBeCloseTo(50)
    expect(sq[1]![1]).toBeCloseTo(100 - 80)
    const rect = d.shapes[1]!
    expect(rect.bounds.minXMm).toBeCloseTo(20)
    expect(rect.bounds.maxXMm).toBeCloseTo(30)
    expect(rect.bounds.minYMm).toBeCloseTo(80)
    expect(rect.bounds.maxYMm).toBeCloseTo(90)
    const skew = points(d.shapes[2]!)
    expect(skew[0]![0]).toBeCloseTo(90)
    expect(skew[1]![0]).toBeCloseTo(100)
    expect(skew[1]![1]).toBeCloseTo(0)
  })

  it('reads every basic shape and use → defs / symbol, named from the palette', () => {
    const d = read('basic-shapes.svg')
    expect(d.diagnostics).toEqual([])
    expect(d.layers.map((l) => l.id)).toEqual(['C00', 'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C15', 'C25'])
    expect(d.layers.every((l) => l.pathCount === 1 && l.palette !== null)).toBe(true)

    expect(byId(d, 'r').lengthMm).toBeCloseTo(100, 9)
    expectFlattenedLength(byId(d, 'rr').lengthMm, 40 + 20 + 2 * Math.PI * 5, 5)
    expectFlattenedLength(byId(d, 'c').lengthMm, 2 * Math.PI * 10, 10)
    expect(circleDeviation(byId(d, 'c'), 105, 80, 10)).toBeLessThanOrEqual(0.01 + 1e-9)
    const a = 15
    const b = 8
    const h = (a - b) ** 2 / (a + b) ** 2
    // Ramanujan's perimeter (error ~1e-5 here); the tightest curvature radius is b²/a.
    expectFlattenedLength(byId(d, 'e').lengthMm, Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), (b * b) / a)
    expect(byId(d, 'l').subpaths[0]!.closed).toBe(false)
    expect(byId(d, 'l').lengthMm).toBeCloseTo(50)
    expect(byId(d, 'pl').subpaths[0]!.closed).toBe(false)
    expect(byId(d, 'pl').lengthMm).toBeCloseTo(3 * Math.SQRT2 * 10)
    expect(byId(d, 'pg').subpaths[0]!.closed).toBe(true)
    expect(byId(d, 'p').bounds.maxXMm).toBeCloseTo(200)

    const small = d.shapes.find((s) => s.stroke === '#a000a0')!
    expect(small.bounds).toEqual({ minXMm: 10, minYMm: 25, maxXMm: 15, maxYMm: 30 })
    const star = d.shapes.find((s) => s.stroke === '#500a78')!
    expect(star.bounds.minXMm).toBeCloseTo(30)
    expect(star.bounds.maxXMm).toBeCloseTo(50)
    expect(star.bounds.minYMm).toBeCloseTo(10)
    expect(star.bounds.maxYMm).toBeCloseTo(30)
  })

  it('flattens arcs exactly, within tolerance', () => {
    const d = read('arcs.svg')
    expect(d.diagnostics).toEqual([])
    const semi = byId(d, 'semi')
    expectFlattenedLength(semi.lengthMm, Math.PI * 20, 20)
    for (const [x, y] of points(semi)) {
      expect(Math.abs(Math.hypot(x - 30, y - 70) - 20)).toBeLessThan(1e-9)
      expect(y).toBeGreaterThanOrEqual(70 - 1e-9) // the upper half
    }
    expectFlattenedLength(byId(d, 'large').lengthMm, 0.75 * 2 * Math.PI * 10, 10)
    const rot = byId(d, 'rot')
    expect(rot.subpaths[0]!.closed).toBe(true)
    const a = 20
    const b = 10
    const h = (a - b) ** 2 / (a + b) ** 2
    expect(rot.lengthMm).toBeCloseTo(Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))), 1)
    expectFlattenedLength(byId(d, 'small').lengthMm, Math.PI * 10, 10)
    expect(byId(d, 'zero').lengthMm).toBeCloseTo(30)
    expect(points(byId(d, 'zero'))).toHaveLength(2)
  })

  it('holds the tolerance in mm whatever the scale', () => {
    for (const tol of [0.01, 0.1]) {
      const d = readSvg(svg('width="200mm" height="200mm" viewBox="0 0 2 2"', '<circle cx="1" cy="1" r="1" stroke="#000" fill="none"/>'), {
        toleranceMm: tol,
      })
      const dev = circleDeviation(d.shapes[0]!, 100, 100, 100)
      expect(dev).toBeLessThanOrEqual(tol + 1e-9)
      expect(dev).toBeGreaterThan(tol / 4) // not wastefully fine
    }
  })

  it('keeps shapes with holes as subpaths with their fill rule', () => {
    const d = read('holes.svg')
    const eo = byId(d, 'evenodd')
    const nz = byId(d, 'nonzero')
    expect(eo.fillRule).toBe('evenodd')
    expect(nz.fillRule).toBe('nonzero')
    for (const s of [eo, nz]) {
      expect(s.subpaths).toHaveLength(2)
      expect(s.subpaths.every((p) => p.closed)).toBe(true)
      expect(s.stroke).toBeNull()
      expect(s.lengthMm).toBeCloseTo(160)
    }
    // A stroked and filled shape is on its stroke layer and its fill layer.
    expect(d.layers.map((l) => [l.id, l.pathCount, l.strokeShapeCount, l.fillShapeCount, l.settings.mode])).toEqual([
      ['C01', 1, 1, 0, 'line'],
      ['C02', 2, 0, 2, 'fill'],
      ['C03', 1, 0, 1, 'fill'],
    ])
  })
})

describe('styles and layers', () => {
  it('cascades attributes < sheet (by specificity) < inline style, and inherits through groups', () => {
    const d = readSvg(
      svg(
        'width="10mm" height="10mm" viewBox="0 0 10 10"',
        `<style>rect { stroke: #ff0000 } .b { stroke: #0000ff } #c { stroke: #00e000 }</style>
         <g stroke="#ff00ff" fill="none">
           <path id="inh" d="M0,0 H1"/>
           <rect id="el" stroke="#000" width="1" height="1"/>
           <rect id="cls" class="a b" width="1" height="1"/>
           <rect id="c" class="b" width="1" height="1"/>
           <rect id="inl" class="b" style="stroke: #ff8000 !important" width="1" height="1"/>
           <path id="cur" style="color:#d0d000" stroke="currentColor" d="M0,0 H1"/>
           <g display="none"><path d="M0,0 H1"/></g>
           <path visibility="hidden" d="M0,0 H1"/>
         </g>`,
      ),
    )
    const stroke = (id: string) => byId(d, id).stroke
    expect(stroke('inh')).toBe('#ff00ff')
    expect(stroke('el')).toBe('#ff0000')
    expect(stroke('cls')).toBe('#0000ff')
    expect(stroke('c')).toBe('#00e000')
    expect(stroke('inl')).toBe('#ff8000')
    expect(stroke('cur')).toBe('#d0d000')
    expect(d.shapes).toHaveLength(6)
  })

  it('defaults fill to black, keeps off-palette colours as their own layer and notes the nearest', () => {
    const d = readSvg(
      svg(
        'width="10mm" height="10mm" viewBox="0 0 10 10"',
        `<path d="M0,0 H5 V5 Z"/>
         <path d="M0,0 H5" stroke="#0000fe" fill="none"/>
         <path d="M0,0 H5" stroke="#123456" fill="none"/>
         <path d="M0,0 H5" stroke="#0000FE" fill="none"/>`,
      ),
    )
    expect(d.layers.map((l) => [l.id, l.pathCount, l.nearestPalette?.name ?? null])).toEqual([
      ['C00', 1, null],
      ['#0000fe', 2, 'C01'],
      ['#123456', 1, nearestPaletteEntry('#123456').entry.name],
    ])
    expect(layer(d, 'C00').settings.mode).toBe('fill')
  })

  it('gives each layer valid default settings', () => {
    for (const mode of ['line', 'fill'] as const) expect(validate(LayerSettings, defaultLayerSettings(mode))).toEqual([])
    expect(validate(LayerSettings, { ...defaultLayerSettings('line'), mode: 'offsetFill' })).not.toEqual([])
  })
})

describe('diagnostics', () => {
  it('lists each problem once with its count, never guessing', () => {
    const d = read('diagnostics.svg')
    expect(codes(d)).toEqual({
      'px-size-assumed-dpi': 1,
      'unsupported-css:g > path': 1,
      'unsupported-css:.a:hover': 1,
      'unsupported-css:@media': 1,
      'text-not-converted': 2,
      'raster-image': 1,
      'clip-path-ignored': 1,
      'mask-ignored': 1,
      'unsupported-element:foreignObject': 1,
      'unsupported-element:blink': 2,
      'unresolved-unit:circle r': 1,
      'unresolved-reference:#missing': 1,
      'invalid-path-data': 1,
      'unsupported-paint:url(#grad)': 1,
      'unpainted-shape': 2,
    })
    // The three paths still import (sheet: blue stroke); clipping and masking are ignored.
    expect(d.layers.map((l) => [l.id, l.pathCount])).toEqual([['C01', 3]])
    expect(d.diagnostics.every((d) => d.message.length > 0)).toBe(true)
  })
})

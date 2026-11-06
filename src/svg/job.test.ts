// SPDX-License-Identifier: MIT
// SVG import placement and Line mode moves (BURN-51). The Rust parser check of
// the same G-code lives in aria-burn (src-tauri/src/job.rs
// `svg_jobs_parse_into_the_core_job_model`).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { beamOn, type LayerSettings, type MachineProfile, type Move } from '../contract/index.ts'
import { loadMachineProfile } from '../sim/index.ts'
import {
  DEFAULT_PLACEMENT,
  anchorPoint,
  apply,
  lineShapes,
  placementMatrix,
  readSvg,
  sourceAt,
  svgJob,
  svgJobLayers,
  type Placement,
  type SvgDocument,
  type SvgJobLayer,
} from './index.ts'

const MACHINE: MachineProfile = loadMachineProfile(
  readFileSync(fileURLToPath(new URL('../profiles/provisional/machine-10w-diode.json', import.meta.url)), 'utf8'),
)
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const svg = (attrs: string, body: string) => readSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)
const at = (p: Partial<Placement>): Placement => ({ ...DEFAULT_PLACEMENT, ...p })
const layersWith = (doc: SvgDocument, change: (id: string, s: LayerSettings) => Partial<LayerSettings> = () => ({})): SvgJobLayer[] =>
  svgJobLayers(doc).map((l) => ({ id: l.id, settings: { ...l.settings, mode: 'line', ...change(l.id, l.settings) } }))

/** Beam-on moves with their start points. */
function burns(moves: readonly Move[]): { x0: number; y0: number; m: Move }[] {
  const out: { x0: number; y0: number; m: Move }[] = []
  let x = 0
  let y = 0
  for (const m of moves) {
    if (beamOn(m)) out.push({ x0: x, y0: y, m })
    x = m.xMm
    y = m.yMm
  }
  return out
}

const sortPts = (pts: [number, number][]) => [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
const ends = (moves: readonly Move[]) => burns(moves).map(({ m }) => [m.xMm, m.yMm] as [number, number])
const uniq = (pts: [number, number][]) => sortPts([...new Map(pts.map((p) => [`${p[0].toFixed(3)},${p[1].toFixed(3)}`, p])).values()])

// A 10 × 4 mm rectangle at SVG (2, 3) on a 20 × 20 mm page: bed x 2..12, y 13..17 (Y up).
const SQUARE = () => svg('width="20mm" height="20mm" viewBox="0 0 20 20"', '<rect x="2" y="3" width="10" height="4" fill="none" stroke="#000000"/>')
const SQUARE_CORNERS: [number, number][] = [
  [2, 13],
  [12, 13],
  [12, 17],
  [2, 17],
]

describe('placement', () => {
  it('the default is the identity: true size, bottom-left of the page at the bed origin', () => {
    expect(placementMatrix(SQUARE(), DEFAULT_PLACEMENT)).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('anchors name the nine points of a box', () => {
    const b = { minXMm: 0, minYMm: 0, maxXMm: 10, maxYMm: 4 }
    expect(anchorPoint(b, 'bottom-left')).toEqual({ xMm: 0, yMm: 0 })
    expect(anchorPoint(b, 'top')).toEqual({ xMm: 5, yMm: 4 })
    expect(anchorPoint(b, 'right')).toEqual({ xMm: 10, yMm: 2 })
    expect(anchorPoint(b, 'center')).toEqual({ xMm: 5, yMm: 2 })
    expect(anchorPoint(b, 'top-right')).toEqual({ xMm: 10, yMm: 4 })
  })

  it('rejects a non-positive scale', () => {
    expect(() => placementMatrix(SQUARE(), at({ scale: 0 }))).toThrow(RangeError)
  })

  it('content reference anchors the drawn geometry, not the page', () => {
    const m = placementMatrix(SQUARE(), at({ reference: 'content', xMm: 50, yMm: 60 }))
    expect(apply(m, 2, 13)).toEqual([50, 60])
  })
})

describe('line mode', () => {
  it('a square at the default placement lands on its SVG coordinates', () => {
    const doc = SQUARE()
    const r = svgJob(doc, svgJobLayers(doc), DEFAULT_PLACEMENT, MACHINE)
    expect(uniq(ends(r.job.moves))).toEqual(sortPts(SQUARE_CORNERS))
    expect(r.job.burnBounds).toEqual({ minXMm: 2, minYMm: 13, maxXMm: 12, maxYMm: 17 })
    expect(r.diagnostics).toEqual([])
    // A closed path is followed all the way round: 4 cuts back to its start.
    const b = burns(r.job.moves)
    expect(b).toHaveLength(4)
    expect([b[3]!.m.xMm, b[3]!.m.yMm]).toEqual([b[0]!.x0, b[0]!.y0])
    // It starts at the vertex nearest the head (the origin).
    expect([b[0]!.x0, b[0]!.y0]).toEqual([2, 13])
  })

  it('a square moved, scaled ×2 and rotated 90° about its centre lands where the transform puts it', () => {
    const doc = SQUARE()
    // Page 20 × 20 → 40 × 40 about its centre (10, 10), turned 90° CCW; its centre anchored at (100, 50).
    const r = svgJob(doc, svgJobLayers(doc), at({ xMm: 100, yMm: 50, anchor: 'center', scale: 2, rotationDeg: 90 }), MACHINE)
    // (x, y) → centre + R90(2·(x − 10, y − 10)) + (90, 40) = (100 − 2(y − 10), 50 + 2(x − 10)).
    const want = SQUARE_CORNERS.map(([x, y]) => [100 - 2 * (y - 10), 50 + 2 * (x - 10)] as [number, number])
    expect(uniq(ends(r.job.moves))).toEqual(sortPts(want))
    expect(r.diagnostics).toEqual([])
  })

  it('a circle keeps its radius × scale about the placed centre', () => {
    const doc = svg('width="30mm" height="30mm" viewBox="0 0 30 30"', '<circle cx="10" cy="10" r="5" fill="none" stroke="#0000ff"/>')
    const p = at({ xMm: 200, yMm: 150, anchor: 'top-right', scale: 1.5, rotationDeg: 33 })
    const r = svgJob(doc, svgJobLayers(doc), p, MACHINE)
    const [cx, cy] = apply(placementMatrix(doc, p), 10, 20) // SVG (10, 10) is (10, 20) Y up
    const pts = ends(r.job.moves)
    expect(pts.length).toBeGreaterThan(16)
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x - cx, y - cy) - 7.5)).toBeLessThan(0.02)
    expect(r.job.passes).toEqual([{ index: 0, firstMove: 0, moveCount: r.job.moves.length, label: 'C01' }])
  })

  it('a design off the bed is reported, not clipped', () => {
    const doc = SQUARE()
    const r = svgJob(doc, svgJobLayers(doc), at({ xMm: 400 }), MACHINE)
    expect(r.diagnostics.map((d) => d.code)).toEqual(['off-bed'])
    expect(r.job.burnBounds!.maxXMm).toBe(412)
    expect(r.designBounds).toEqual({ minXMm: 402, minYMm: 13, maxXMm: 412, maxYMm: 17 })
  })

  it('power, speed and comments: M4, S from max % of $30, F from speed, a labelled pass per layer pass', () => {
    const doc = SQUARE()
    const r = svgJob(doc, layersWith(doc, () => ({ maxPowerPct: 45, minPowerPct: 10, speedMmPerMin: 1200 })), DEFAULT_PLACEMENT, MACHINE)
    for (const { m } of burns(r.job.moves)) expect([m.laser, m.s, m.feedMmPerMin]).toEqual(['m4', 450, 1200])
    const lines = r.gcode.split('\n')
    expect(lines).toContain('; Layer C00')
    expect(lines).toContain('; Line @ 1200 mm/min, 45% power')
    expect(lines.filter((l) => l.startsWith('G1')).every((l) => /^G1 X[\d.]+ Y[\d.]+( F\d+)?( S[\d.]+)?$/.test(l))).toBe(true)
  })

  it('passes repeat a layer in the same order, each labelled, with the parser multi-pass warning', () => {
    const doc = SQUARE()
    const r = svgJob(doc, layersWith(doc, () => ({ passes: 3 })), DEFAULT_PLACEMENT, MACHINE)
    const passes = r.job.passes
    expect(passes.map((p) => p.label)).toEqual(['C00', 'C00', 'C00'])
    const geom = passes.map((p) => burns(r.job.moves.slice(p.firstMove, p.firstMove + p.moveCount)).map(({ m }) => [m.xMm, m.yMm]))
    expect(geom[1]).toEqual(geom[0])
    expect(geom[2]).toEqual(geom[0])
    expect(r.job.diagnostics.map((d) => d.code)).toEqual(['multi-pass'])
    expect(r.gcode).toContain('; Line @ 1500 mm/min, 30% power, pass 3 of 3')
  })

  it('an output-off layer leaves no beam-on moves; a hidden layer writes nothing', () => {
    const doc = svg(
      'width="50mm" height="50mm" viewBox="0 0 50 50"',
      '<rect x="5" y="5" width="10" height="10" fill="none" stroke="#000000"/>' +
        '<rect x="30" y="30" width="10" height="10" fill="none" stroke="#ff0000"/>' +
        '<path d="M20,45 H40" fill="none" stroke="#0000ff"/>',
    )
    expect(doc.layers.map((l) => l.id)).toEqual(['C00', 'C01', 'C02'])
    const r = svgJob(doc, layersWith(doc, (id) => (id === 'C02' ? { output: false } : id === 'C01' ? { visible: false } : {})), DEFAULT_PLACEMENT, MACHINE)
    expect(r.job.burnBounds).toEqual({ minXMm: 5, minYMm: 35, maxXMm: 15, maxYMm: 45 })
    expect(r.gcode).toContain('; Layer C00')
    expect(r.gcode).not.toContain('C01')
    expect(r.gcode).not.toContain('C02')
    // Everything off: nothing burns, and that is reported.
    const none = svgJob(doc, layersWith(doc, () => ({ output: false })), DEFAULT_PLACEMENT, MACHINE)
    expect(none.job.moves).toEqual([])
    expect(none.diagnostics.map((d) => d.code)).toEqual(['nothing-to-burn'])
  })

  it('layers burn in list order; unknown, duplicate and fill layers are reported', () => {
    const doc = svg(
      'width="50mm" height="50mm" viewBox="0 0 50 50"',
      '<path d="M5,5 H15" stroke="#000000"/><path d="M5,25 H15" stroke="#ff0000"/><rect x="30" y="30" width="5" height="5" fill="#0000ff"/>',
    )
    const base = svgJobLayers(doc)
    const c00 = base.find((l) => l.id === 'C00')!
    const c01 = base.find((l) => l.id === 'C01')!
    const c02 = base.find((l) => l.id === 'C02')!
    expect(c01.settings.mode).toBe('fill')
    const r = svgJob(doc, [c02, c00, { id: 'C09', settings: c00.settings }, c00, c01], DEFAULT_PLACEMENT, MACHINE)
    expect(r.job.passes.map((p) => p.label)).toEqual(['C02', 'C00'])
    expect(r.diagnostics.map((d) => [d.code, d.layer])).toEqual([
      ['unknown-layer', 'C09'],
      ['duplicate-layer', 'C00'],
      ['fill-not-available', 'C01'],
    ])
  })

  it('line mode traces shapes stroked in the layer colour and unstroked ones, not a stroked shape there only by its default fill', () => {
    // The red path has no fill="none", so SVG's default black fill puts it on C00 too.
    const doc = svg(
      'width="50mm" height="50mm" viewBox="0 0 50 50"',
      '<path d="M5,5 H15" stroke="#ff0000"/><rect x="30" y="30" width="5" height="5" fill="#000000"/><path d="M5,40 H15" fill="none" stroke="#000000"/>',
    )
    const c00 = doc.layers.findIndex((l) => l.id === 'C00')
    expect(doc.layers[c00]!.shapes).toEqual([0, 1, 2])
    expect(lineShapes(doc, c00)).toEqual([1, 2])
    expect(lineShapes(doc, doc.layers.findIndex((l) => l.color === '#ff0000'))).toEqual([0])
    const r = svgJob(doc, layersWith(doc, () => ({ mode: 'line' })), DEFAULT_PLACEMENT, MACHINE)
    const c00Shapes = new Set<number>()
    for (const { m } of burns(r.job.moves)) {
      const src = sourceAt(r.sourceMap, m.line)!
      if (doc.layers[src.layer]!.id === 'C00') c00Shapes.add(src.shape)
    }
    expect([...c00Shapes].sort()).toEqual([1, 2])
  })

  it('inner closed shapes go before the shapes around them; open paths are reversed when their far end is nearer', () => {
    const doc = readSvg(fixture('holes.svg'))
    const r = svgJob(doc, layersWith(doc), DEFAULT_PLACEMENT, MACHINE)
    // Each hole (subpath 1) is burned before its square (subpath 0).
    const order: string[] = []
    for (const { m } of burns(r.job.moves)) {
      const src = sourceAt(r.sourceMap, m.line)!
      const key = `${doc.shapes[src.shape]!.id}/${src.subpath}`
      if (order[order.length - 1] !== key) order.push(key)
    }
    expect(order.indexOf('evenodd/1')).toBeLessThan(order.indexOf('evenodd/0'))
    expect(order.indexOf('nonzero/1')).toBeLessThan(order.indexOf('nonzero/0'))

    // Two lines; the second is nearer the end of the first by its far end, so it is reversed.
    const lines = svg('width="50mm" height="50mm" viewBox="0 0 50 50"', '<path d="M0,50 H10 M40,45 H11" stroke="#000000"/>')
    const lr = svgJob(lines, svgJobLayers(lines), DEFAULT_PLACEMENT, MACHINE)
    expect(burns(lr.job.moves).map(({ x0, y0, m }) => [x0, y0, m.xMm, m.yMm])).toEqual([
      [0, 0, 10, 0],
      [11, 5, 40, 5],
    ])
  })

  it('the source map names the layer, shape, subpath and pass of every move line', () => {
    const doc = readSvg(fixture('aria-studio-laser.svg'))
    const r = svgJob(doc, layersWith(doc, () => ({ passes: 2 })), DEFAULT_PLACEMENT, MACHINE)
    expect(r.sourceMap.layer).toHaveLength(r.gcode.trimEnd().split('\n').length)
    for (const m of r.job.moves) {
      const src = sourceAt(r.sourceMap, m.line)
      expect(src).not.toBeNull()
      const layer = doc.layers[src!.layer]!
      expect(layer.shapes).toContain(src!.shape)
      expect(src!.subpath).toBeLessThan(doc.shapes[src!.shape]!.subpaths.length)
    }
    for (const p of r.job.passes) {
      const src = sourceAt(r.sourceMap, r.job.moves[p.firstMove]!.line)!
      expect(doc.layers[src.layer]!.id).toBe(p.label)
    }
    expect(sourceAt(r.sourceMap, 1)).toBeNull()
  })

  it('every move is one G-code line with exactly its coordinates, feed and S', () => {
    const doc = readSvg(fixture('basic-shapes.svg'))
    const r = svgJob(doc, layersWith(doc), at({ xMm: 50, yMm: 50, rotationDeg: 17, scale: 0.8 }), MACHINE)
    const lines = r.gcode.trimEnd().split('\n')
    expect(r.job.source.lineCount).toBe(lines.length)
    let feed = 0
    let s = 0
    for (const m of r.job.moves) {
      const text = lines[m.line - 1]!
      const w = Object.fromEntries([...text.matchAll(/([GXYFS])(-?[\d.]+)/g)].map((x) => [x[1], Number(x[2])]))
      expect(w.G).toBe(m.kind === 'g0' ? 0 : 1)
      expect([w.X, w.Y]).toEqual([m.xMm, m.yMm])
      if (w.F !== undefined) feed = w.F
      if (w.S !== undefined) s = w.S
      if (m.kind === 'g1') expect([m.feedMmPerMin, m.s]).toEqual([feed, s])
    }
  })

  it('orders a large design quickly', () => {
    const cells: string[] = []
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) cells.push(`<rect x="${i * 2}" y="${j * 2}" width="1" height="1"/><rect x="${i * 2 + 0.25}" y="${j * 2 + 0.25}" width="0.5" height="0.5"/>`)
    const doc = svg('width="200mm" height="200mm" viewBox="0 0 200 200"', `<g fill="none" stroke="#000000">${cells.join('')}</g>`)
    const t = performance.now()
    const r = svgJob(doc, svgJobLayers(doc), DEFAULT_PLACEMENT, MACHINE)
    expect(performance.now() - t).toBeLessThan(5000)
    expect(burns(r.job.moves)).toHaveLength(20000 * 4)
  })
})

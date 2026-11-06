// SPDX-License-Identifier: MIT
// SVG import Fill mode (BURN-52). The Rust parser check of the same G-code
// lives in aria-burn (src-tauri/src/job.rs `svg_jobs_parse_into_the_core_job_model`).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { beamOn, decodeSampleBatch, type FillSettings, type LayerSettings, type MachineProfile, type Move } from '../contract/index.ts'
import { SampleStore, interimSampler, loadMachineProfile, loadMaterialProfile, setupJob, simulateCpu, stitch } from '../sim/index.ts'
import { DEFAULT_PLACEMENT, readSvg, scanLines, sourceAt, svgJob, svgJobLayers, type SvgDocument, type SvgJobLayer } from './index.ts'

const provisional = (name: string) => readFileSync(fileURLToPath(new URL(`../profiles/provisional/${name}`, import.meta.url)), 'utf8')
const MACHINE: MachineProfile = loadMachineProfile(provisional('machine-10w-diode.json'))
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
const page = (body: string, size = 50) => readSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}mm" height="${size}mm" viewBox="0 0 ${size} ${size}">${body}</svg>`)

/** Every layer in fill mode with these fill settings (no overscan unless asked). */
const fillLayers = (doc: SvgDocument, fill: Partial<FillSettings> = {}, more: Partial<LayerSettings> = {}): SvgJobLayer[] =>
  svgJobLayers(doc).map((l) => ({
    id: l.id,
    settings: { ...l.settings, mode: 'fill', ...more, fill: { ...l.settings.fill, overscanMm: 0, ...fill } },
  }))

interface Seg {
  x0: number
  y0: number
  m: Move
}

function segs(moves: readonly Move[]): Seg[] {
  const out: Seg[] = []
  let x = 0
  let y = 0
  for (const m of moves) {
    out.push({ x0: x, y0: y, m })
    x = m.xMm
    y = m.yMm
  }
  return out
}
const burned = (moves: readonly Move[]) => segs(moves).filter((s) => beamOn(s.m))
const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps

/** Beam-on segments on horizontal scan lines that overlap the open box (x0, x1) × (y0, y1). */
const hits = (moves: readonly Move[], x0: number, x1: number, y0: number, y1: number) =>
  burned(moves).filter(({ x0: ax, y0: ay, m }) => ay > y0 && ay < y1 && Math.max(ax, m.xMm) > x0 && Math.min(ax, m.xMm) < x1)

describe('fill mode', () => {
  it('a 10 mm square at 0.1 mm gives 100 lines inside its bounds', () => {
    const doc = page('<rect x="10" y="10" width="10" height="10" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.1 }), DEFAULT_PLACEMENT, MACHINE)
    const b = burned(r.job.moves)
    expect(b).toHaveLength(100)
    const ys = b.map((s) => s.m.yMm)
    expect(new Set(ys).size).toBe(100)
    for (const { x0, y0, m } of b) {
      expect(y0).toBe(m.yMm)
      expect(m.yMm).toBeGreaterThan(30)
      expect(m.yMm).toBeLessThan(40)
      expect(Math.min(x0, m.xMm)).toBeCloseTo(10, 6)
      expect(Math.max(x0, m.xMm)).toBeCloseTo(20, 6)
    }
    // Bottom to top, half an interval in from the edges.
    expect(ys[0]).toBeCloseTo(30.05, 6)
    expect(ys[99]).toBeCloseTo(39.95, 6)
    expect(ys.every((y, i) => i === 0 || y > ys[i - 1]!)).toBe(true)
    expect(r.job.passes.map((p) => p.label)).toEqual(['C00'])
    expect(r.gcode).toContain('; Fill @ 1500 mm/min, 30% power')
    expect(r.diagnostics).toEqual([])
  })

  it('back-and-forth alternates direction; one direction returns with G0', () => {
    const doc = page('<rect x="10" y="10" width="10" height="2" fill="#000000"/>')
    const bi = burned(svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE).job.moves)
    expect(bi.map(({ x0, m }) => Math.sign(m.xMm - x0))).toEqual([1, -1, 1, -1])
    const one = svgJob(doc, fillLayers(doc, { intervalMm: 0.5, bidirectional: false, overscanMm: 1 }), DEFAULT_PLACEMENT, MACHINE)
    expect(burned(one.job.moves).map(({ x0, m }) => Math.sign(m.xMm - x0))).toEqual([1, 1, 1, 1])
    // Every line starts with a G0 to its overscan start; the beam is never on in a G0.
    const g0 = segs(one.job.moves).filter((s) => s.m.kind === 'g0')
    expect(g0.map((s) => [s.m.xMm, s.m.yMm])).toEqual([
      [9, 38.25],
      [9, 38.75],
      [9, 39.25],
      [9, 39.75],
    ])
  })

  it('a ring leaves its hole empty under both fill rules', () => {
    // holes.svg: 30 mm squares with a 10 mm hole at x 20..30 (even-odd, same winding) and 70..80 (nonzero, opposite winding), y 20..30 bed.
    const doc = readSvg(fixture('holes.svg'))
    const ids = svgJobLayers(doc).map((l) => l.id)
    const red = doc.layers.find((l) => l.color === '#ff0000')!
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.2 }).filter((l) => l.id === red.id), DEFAULT_PLACEMENT, MACHINE)
    expect(ids).toContain(red.id)
    expect(hits(r.job.moves, 20, 30, 20, 30)).toEqual([])
    expect(hits(r.job.moves, 70, 80, 20, 30)).toEqual([])
    // Beside the holes the shapes are filled, two spans per line through the hole.
    expect(hits(r.job.moves, 10, 20, 20, 30).length).toBe(50)
    expect(hits(r.job.moves, 30, 40, 20, 30).length).toBe(50)
    expect(hits(r.job.moves, 60, 70, 20, 30).length).toBe(50)
    expect(hits(r.job.moves, 80, 90, 20, 30).length).toBe(50)
    expect(hits(r.job.moves, 10, 40, 10, 20).length).toBe(50)
  })

  it('two overlapping same-direction subpaths: even-odd leaves the overlap empty, nonzero fills it', () => {
    const d = 'M0,0 H20 V20 H0 Z M10,10 H30 V30 H10 Z'
    const run = (rule: string) => {
      const doc = page(`<path d="${d}" fill="#000000" fill-rule="${rule}"/>`, 30)
      return svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE).job.moves
    }
    // Bed y = 30 - SVG y: the overlap is x 10..20, y 10..20.
    const evenodd = run('evenodd')
    const nonzero = run('nonzero')
    expect(hits(evenodd, 10, 20, 10, 20)).toEqual([])
    expect(hits(nonzero, 10, 20, 10, 20).length).toBe(20)
    // Outside the overlap both fill the same.
    expect(hits(evenodd, 0, 10, 10, 20).length).toBe(20)
    expect(hits(nonzero, 0, 10, 10, 20).length).toBe(20)
    // Separate shapes are unioned whatever their rule.
    const two = page('<rect x="0" y="0" width="20" height="20" fill="#000000" fill-rule="evenodd"/><rect x="10" y="10" width="20" height="20" fill="#000000" fill-rule="evenodd"/>', 30)
    const tr = svgJob(two, fillLayers(two, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE)
    expect(hits(tr.job.moves, 10, 20, 10, 20).length).toBe(20)
  })

  it('at 45° every line lies at 45°', () => {
    const doc = page('<circle cx="25" cy="25" r="10" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5, angleDeg: 45 }), DEFAULT_PLACEMENT, MACHINE)
    const b = burned(r.job.moves)
    expect(b.length).toBeGreaterThan(30)
    for (const { x0, y0, m } of b) {
      const deg = (Math.atan2(m.yMm - y0, m.xMm - x0) * 180) / Math.PI
      // 0.001 mm rounding on lines down to a fraction of a mm long.
      const tol = (0.002 / Math.hypot(m.xMm - x0, m.yMm - y0)) * (180 / Math.PI) + 1e-6
      expect(Math.min(Math.abs(deg - 45), Math.abs(deg + 135))).toBeLessThanOrEqual(tol)
    }
    // No scan offset on this machine, so no note.
    expect(r.diagnostics).toEqual([])
  })

  it('overscan runs beam-off at the same feed, outside the shape', () => {
    const doc = page('<rect x="10" y="10" width="10" height="1" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5, overscanMm: 2 }), DEFAULT_PLACEMENT, MACHINE)
    const g1 = segs(r.job.moves).filter((s) => s.m.kind === 'g1')
    expect(g1).toHaveLength(6)
    for (const { x0, y0, m } of g1) {
      expect(m.feedMmPerMin).toBe(1500)
      expect(m.yMm).toBe(y0)
      if (beamOn(m)) continue
      expect(m.s).toBe(0)
      expect(Math.abs(m.xMm - x0)).toBeCloseTo(2, 6)
      // Each overscan run lies entirely outside the 10..20 shape.
      expect(Math.max(x0, m.xMm) <= 10 + 1e-9 || Math.min(x0, m.xMm) >= 20 - 1e-9).toBe(true)
    }
    expect(r.gcode).toContain('G0 X8 Y39.25\nG1 X10 Y39.25 F1500\nG1 X20 Y39.25 S300\nG1 X22 Y39.25 S0\nG0 X22 Y39.75\nG1 X20 Y39.75\n')
    expect(r.job.burnBounds).toEqual({ minXMm: 10, minYMm: 39.25, maxXMm: 20, maxYMm: 39.75 })
  })

  it('gaps between spans on one line are crossed beam-off at feed, not with G0', () => {
    const doc = page('<rect x="10" y="10" width="5" height="1" fill="#000000"/><rect x="25" y="10" width="5" height="1" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE)
    const s = segs(r.job.moves)
    expect(s.map(({ m }) => (m.kind === 'g0' ? 'G0' : beamOn(m) ? 'on' : 'off'))).toEqual(['G0', 'on', 'off', 'on', 'G0', 'on', 'off', 'on'])
    expect(s[2]!.x0).toBe(15)
    expect(s[2]!.m.xMm).toBe(25)
  })

  it('crosshatch doubles the lines, the second set at angle + 90°', () => {
    const doc = page('<rect x="10" y="10" width="10" height="10" fill="#000000"/>')
    const plain = burned(svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE).job.moves)
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5, crosshatch: true }), DEFAULT_PLACEMENT, MACHINE)
    const hatch = burned(r.job.moves)
    expect(hatch).toHaveLength(2 * plain.length)
    expect(hatch.slice(0, plain.length).every(({ y0, m }) => m.yMm === y0)).toBe(true)
    expect(hatch.slice(plain.length).every(({ x0, m }) => m.xMm === x0)).toBe(true)
    expect(r.gcode).toContain('; Crosshatch at 90 deg')
    // Still one pass per layer pass.
    expect(r.job.passes.map((p) => p.label)).toEqual(['C00'])
  })

  it('passes repeat the fill, labelled by layer', () => {
    const doc = page('<rect x="10" y="10" width="4" height="2" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }, { passes: 2 }), DEFAULT_PLACEMENT, MACHINE)
    expect(r.job.passes.map((p) => p.label)).toEqual(['C00', 'C00'])
    expect(r.job.diagnostics.map((d) => d.code)).toEqual(['multi-pass'])
    expect(r.gcode).toContain('; Fill @ 1500 mm/min, 30% power, pass 2 of 2')
  })

  it('open paths on a fill layer are reported with their count and skipped', () => {
    const doc = page('<rect x="10" y="10" width="4" height="2" fill="#000000"/><path d="M5,40 H45 M5,45 H45" fill="none" stroke="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5 }), DEFAULT_PLACEMENT, MACHINE)
    expect(r.diagnostics.map((d) => [d.code, d.layer, d.message])).toEqual([
      ['fill-open-paths', 'C00', 'Layer C00 has 2 open paths, which fill cannot burn; they are skipped'],
    ])
    expect(r.job.burnBounds).toEqual({ minXMm: 10, minYMm: 38.25, maxXMm: 14, maxYMm: 39.75 })
    // A layer of open paths only writes nothing.
    const lines = page('<path d="M5,40 H45" fill="none" stroke="#000000"/>')
    const lr = svgJob(lines, fillLayers(lines), DEFAULT_PLACEMENT, MACHINE)
    expect(lr.job.moves).toEqual([])
    expect(lr.diagnostics.map((d) => d.code)).toEqual(['fill-open-paths', 'nothing-to-burn'])
  })

  it('notes the scan offset is not applied to angled lines', () => {
    const offset: MachineProfile = { ...MACHINE, scanOffsetMm: [{ feedMmPerMin: 3000, offsetMm: 0.2 }] }
    const doc = page('<rect x="10" y="10" width="4" height="4" fill="#000000"/>')
    const code = (fill: Partial<FillSettings>) => svgJob(doc, fillLayers(doc, fill), DEFAULT_PLACEMENT, offset).diagnostics.map((d) => d.code)
    expect(code({ angleDeg: 0 })).toEqual([])
    expect(code({ angleDeg: 180.5 })).toEqual([])
    expect(code({ angleDeg: 0, bidirectional: false, crosshatch: true })).toEqual([])
    expect(code({ angleDeg: 30 })).toEqual(['fill-scan-offset'])
    const hatch = svgJob(doc, fillLayers(doc, { crosshatch: true }), DEFAULT_PLACEMENT, offset).diagnostics
    expect(hatch.map((d) => [d.code, d.layer])).toEqual([['fill-scan-offset', 'C00']])
    expect(hatch[0]!.message).toContain('scans at 90 deg')
  })

  it('overscan past the bed edge is reported when the design itself is on the bed', () => {
    const doc = page('<rect x="0" y="40" width="10" height="10" fill="#000000"/>')
    const r = svgJob(doc, fillLayers(doc, { overscanMm: 2 }), DEFAULT_PLACEMENT, MACHINE)
    expect(r.diagnostics.map((d) => d.code)).toEqual(['overscan-off-bed'])
    expect(r.job.bounds.minXMm).toBe(-2)
  })

  it('every move is one G-code line and the source map names the fill shape', () => {
    const doc = readSvg(fixture('holes.svg'))
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.5, angleDeg: 30, overscanMm: 1, crosshatch: true }), DEFAULT_PLACEMENT, MACHINE)
    const lines = r.gcode.trimEnd().split('\n')
    expect(r.job.source.lineCount).toBe(lines.length)
    let feed = 0
    let s = 0
    for (const m of r.job.moves) {
      const w = Object.fromEntries([...lines[m.line - 1]!.matchAll(/([GXYFS])(-?[\d.]+)/g)].map((x) => [x[1], Number(x[2])]))
      expect(w.G).toBe(m.kind === 'g0' ? 0 : 1)
      expect([w.X, w.Y]).toEqual([m.xMm, m.yMm])
      if (w.F !== undefined) feed = w.F
      if (w.S !== undefined) s = w.S
      if (m.kind === 'g1') expect([m.feedMmPerMin, m.s]).toEqual([feed, s])
      const src = sourceAt(r.sourceMap, m.line)!
      expect(doc.layers[src.layer]!.shapes).toContain(src.shape)
      expect(src.subpath).toBe(-1)
    }
  })

  it('scanLines is the union of shapes, each by its own rule', () => {
    const sq = (x: number, y: number, w: number, cw = false) => {
      const p = [x, y, x + w, y, x + w, y + w, x, y + w]
      if (cw) for (let i = 2, j = 6; i < j; i += 2, j -= 2) [p[i], p[i + 1], p[j], p[j + 1]] = [p[j]!, p[j + 1]!, p[i]!, p[i + 1]!]
      return new Float64Array(p)
    }
    // Nonzero with the hole wound the same way: no hole.
    const lines = scanLines([{ rings: [sq(0, 0, 10), sq(3, 3, 4)], fillRule: 'nonzero', shape: 7 }], 0, 1)
    expect(lines).toHaveLength(10)
    expect(lines.every((l) => l.spans.length === 1 && l.spans[0]!.shape === 7)).toBe(true)
    // Wound the other way: a hole.
    const ring = scanLines([{ rings: [sq(0, 0, 10), sq(3, 3, 4, true)], fillRule: 'nonzero', shape: 0 }], 0, 1)
    expect(ring[5]!.spans.map((sp) => [sp.a0, sp.a1])).toEqual([
      [0, 3],
      [7, 10],
    ])
    expect(() => scanLines([], 0, 0)).toThrow(RangeError)
  })
})

describe('fill through the simulator', () => {
  it('the hole of a filled ring stays unmarked', () => {
    const wood = loadMaterialProfile(provisional('birch-ply.json'))
    // A 12 mm square with a 4 mm hole, nonzero with opposite winding.
    const doc = page('<path d="M4,4 H16 V16 H4 Z M8,8 V12 H12 V8 Z" fill="#000000"/>', 20)
    const r = svgJob(doc, fillLayers(doc, { intervalMm: 0.2 }, { maxPowerPct: 60, speedMmPerMin: 3000 }), DEFAULT_PLACEMENT, MACHINE)
    const plan = interimSampler.plan(r.job, MACHINE, 1)
    const store = new SampleStore(1)
    for (const b of plan.batches) store.append(decodeSampleBatch(b))
    const setup = setupJob(r.job.burnBounds!, MACHINE, wood, { pitchMm: 0.1 })
    const out = stitch(simulateCpu(store, setup))
    const { originXMm, originYMm, pitchMm, width } = setup.grid
    const at = (x: number, y: number) => out.fluence.data[Math.floor((y - originYMm) / pitchMm) * width + Math.floor((x - originXMm) / pitchMm)]!
    const body = at(6, 10)
    expect(body).toBeGreaterThan(0)
    // The hole centre gets under 1 % of the filled body's fluence, and well under the char threshold.
    expect(at(10, 10)).toBeLessThan(body * 0.01)
    expect(at(10, 10)).toBeLessThan(at(14, 10) * 0.01)
  }, 60_000)
})

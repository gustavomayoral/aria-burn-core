// SPDX-License-Identifier: MIT
// The calibration patterns (BURN-32). Each generator lays its pattern out in
// local millimetres and draws it on a Toolpath; generate.ts places it on the
// bed, adds registration marks and writes the G-code.
//
// Layout conventions (all patterns): rows run top to bottom and energy grows
// left to right and downwards, so the most burned cell is bottom right.
// Labels are engraved with the material's label setting.

import {
  DEFAULT_MIN_POWER_FRACTION,
  MIN_FEED_MM_PER_MIN,
  axisRate,
  defaultIntervalMm,
  fillFeedCap,
  fillForEnergy,
  fillSettings,
  fractionForPower,
  labelSettings,
  lineForEnergy,
  materialMid,
  materialRange,
  overscanMm,
  powerAt,
  spotDiameterMm,
  type PatternContext,
} from './context.ts'
import { textStrokes, textWidthMm } from './font.ts'
import type { Toolpath } from './toolpath.ts'
import { PatternFitError, type CellSettings, type PatternCell, type PatternKind, type PatternMark, type ScanAxis } from './types.ts'

/** A pattern laid out in local mm, before placement. */
export interface PatternDraft {
  title: string
  options: Record<string, unknown>
  cells: PatternCell[]
  marks: PatternMark[]
  draw(tp: Toolpath): void
}

export interface PatternGenerator<O extends object = Record<string, unknown>> {
  kind: PatternKind
  title: string
  /** One line for the UI: what the pattern shows. */
  summary: string
  /** Options with every default filled in for this machine and material. */
  defaults(ctx: PatternContext): O
  /** Lays the pattern out. `scale` (≤ 1) shrinks sizes when the full layout doesn't fit the bed. */
  build(ctx: PatternContext, options: O, scale: number): PatternDraft
}

// ── helpers ───────────────────────────────────────────────────────────

const r3 = (v: number) => Math.round(v * 1000) / 1000
const rect = (x0: number, y0: number, x1: number, y1: number) => ({ minXMm: r3(x0), minYMm: r3(y0), maxXMm: r3(x1), maxYMm: r3(y1) })

/** Engraves `text` (no-op for an empty string). */
function label(tp: Toolpath, ctx: PatternContext, text: string, x: number, y: number, h: number, align: 'start' | 'middle' | 'end' = 'start'): void {
  if (text) tp.strokes(textStrokes(text, x, y, h, align), labelSettings(ctx))
}

const fmtFeed = (f: number) => String(Math.round(f))
const fmtPct = (p: number) => (p >= 10 ? p.toFixed(0) : p.toFixed(1))
const fmtE = (e: number) => (e >= 10 ? e.toFixed(0) : e >= 1 ? e.toFixed(1) : e.toFixed(2))

/** Geometric steps from a to b (inclusive), `n` values. */
function geometric(a: number, b: number, n: number): number[] {
  if (n === 1) return [Math.sqrt(a * b)]
  return Array.from({ length: n }, (_, i) => a * (b / a) ** (i / (n - 1)))
}

function linear(a: number, b: number, n: number): number[] {
  if (n === 1) return [(a + b) / 2]
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
}

/** Rounds a feed to a tidy step (10 mm/min under 1000, 50 above). */
const tidyFeed = (f: number) => (f < 1000 ? Math.round(f / 10) * 10 : Math.round(f / 50) * 50)

function fillCell(tp: Toolpath, ctx: PatternContext, cell: PatternCell): void {
  const s = cell.settings
  tp.fillRect(cell.rectMm, s, overscanMm(ctx, s.feedMmPerMin, s.scan ?? 'x'))
}

// ── 1. Power × speed grid ─────────────────────────────────────────────

export interface GridOptions {
  /** Power steps, % of $30, left to right. */
  powersPct: number[]
  /** Feed steps (mm/min), top to bottom. */
  feedsMmPerMin: number[]
  cellMm: number
  gapMm: number
  intervalMm: number
  labelMm: number
}

/** Feed range a grid spans for a material: lowest energy (low power, fast) near half of `under`, highest (full power, slow) past `over`. */
function gridFeedRange(ctx: PatternContext, minFraction: number, intervalMm: number): [number, number] {
  const { lo, hi } = materialRange(ctx)
  const cap = fillFeedCap(ctx, 'x')
  const clamp = (f: number) => Math.min(cap, Math.max(MIN_FEED_MM_PER_MIN, f))
  let fast = clamp((powerAt(ctx, minFraction) / (intervalMm * lo * 0.5)) * 60)
  let slow = clamp((ctx.machine.opticalPowerW / (intervalMm * hi * 1.5)) * 60)
  if (slow > fast / 2) slow = Math.max(MIN_FEED_MM_PER_MIN, fast / 4)
  if (slow >= fast) fast = Math.min(cap, slow * 4)
  return [slow, fast]
}

export const gridPattern: PatternGenerator<GridOptions> = {
  kind: 'grid',
  title: 'Power × speed grid',
  summary: 'Fills at every power and speed step. Pick the cell that looks right and save its settings.',
  defaults(ctx) {
    const intervalMm = defaultIntervalMm(ctx)
    const [slow, fast] = gridFeedRange(ctx, DEFAULT_MIN_POWER_FRACTION, intervalMm)
    return {
      powersPct: linear(DEFAULT_MIN_POWER_FRACTION * 100, 100, 7).map((p) => Math.round(p)),
      feedsMmPerMin: geometric(fast, slow, 6).map(tidyFeed),
      cellMm: 6,
      gapMm: 1.5,
      intervalMm,
      labelMm: 2,
    }
  },
  build(ctx, o, scale) {
    const cell = Math.max(3, o.cellMm * scale)
    const gap = Math.max(1, o.gapMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const rows = o.feedsMmPerMin.length
    const cols = o.powersPct.length
    const feedLabels = o.feedsMmPerMin.map(fmtFeed)
    const x0 = Math.max(...feedLabels.map((t) => textWidthMm(t, lh)), textWidthMm('F', lh)) + gap
    const yTop = rows * (cell + gap) - gap
    const cells: PatternCell[] = []
    for (let r = 0; r < rows; r++) {
      const y1 = yTop - r * (cell + gap)
      for (let c = 0; c < cols; c++) {
        const x = x0 + c * (cell + gap)
        const settings = fillSettings(ctx, o.powersPct[c]! / 100, o.feedsMmPerMin[r]!, o.intervalMm, 'x')
        cells.push({
          id: `r${r + 1}c${c + 1}`,
          label: `${fmtPct(settings.powerPct)}% ${fmtFeed(settings.feedMmPerMin)}`,
          rectMm: rect(x, y1 - cell, x + cell, y1),
          settings,
          row: r,
          col: c,
        })
      }
    }
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (let r = 0; r < rows; r++) {
          const row = cells.filter((k) => k.row === r)
          const s0 = row[0]!.settings
          const spans = row.map((k) => ({ a0: k.rectMm.minXMm, a1: k.rectMm.maxXMm, s: k.settings.s }))
          tp.raster('x', spans, row[0]!.rectMm.minYMm, row[0]!.rectMm.maxYMm, o.intervalMm, s0.feedMmPerMin, overscanMm(ctx, s0.feedMmPerMin, 'x'))
        }
        for (let r = 0; r < rows; r++) {
          const k = cells.find((c) => c.row === r)!
          label(tp, ctx, feedLabels[r]!, x0 - gap, (k.rectMm.minYMm + k.rectMm.maxYMm - lh) / 2, lh, 'end')
        }
        for (let c = 0; c < cols; c++) {
          const k = cells.find((x) => x.col === c && x.row === 0)!
          label(tp, ctx, fmtPct(k.settings.powerPct), (k.rectMm.minXMm + k.rectMm.maxXMm) / 2, yTop + gap, lh, 'middle')
        }
        label(tp, ctx, 'F', x0 - gap, yTop + gap, lh, 'end')
        label(tp, ctx, 'S%', x0, yTop + 2 * gap + lh, lh)
      },
    }
  },
}

// ── 2. Equal-energy pairs ─────────────────────────────────────────────

export interface EqualEnergyOptions {
  /** Target incident energies (J/mm²), top to bottom. */
  energiesJPerMm2: number[]
  /** Combinations per energy, fastest first. */
  combos: number
  /** Feed (and power) ratio between neighbouring combinations. */
  ratio: number
  cellMm: number
  gapMm: number
  intervalMm: number
  labelMm: number
}

/** The power/feed combinations reaching `energy` with this interval, fastest first. */
function equalEnergyCombos(ctx: PatternContext, energy: number, o: EqualEnergyOptions): CellSettings[] {
  const cap = fillFeedCap(ctx, 'x')
  const pMin = powerAt(ctx, DEFAULT_MIN_POWER_FRACTION)
  // Fastest: full power (or the feed cap), rounded down to a tidy feed so the halvings stay round.
  let feed = Math.floor(Math.min(cap, (ctx.machine.opticalPowerW / (energy * o.intervalMm)) * 60) / 40) * 40
  const out: CellSettings[] = []
  for (let i = 0; i < o.combos; i++, feed /= o.ratio) {
    const power = (energy * o.intervalMm * feed) / 60
    if (feed < MIN_FEED_MM_PER_MIN || power < pMin) break
    const fraction = fractionForPower(ctx, power)
    if (fraction === null) continue
    out.push(fillSettings(ctx, fraction, feed, o.intervalMm, 'x'))
  }
  return out
}

export const equalEnergyPattern: PatternGenerator<EqualEnergyOptions> = {
  kind: 'equal-energy',
  title: 'Equal-energy pairs',
  summary: 'Each row reaches one energy per area with different power and speed. If the cells differ, speed matters, not just energy.',
  defaults(ctx) {
    const { lo, hi } = materialRange(ctx)
    return {
      energiesJPerMm2: geometric(lo * 1.5, Math.max(lo * 2, hi * 0.7), 3).map((e) => Math.round(e * 1000) / 1000),
      combos: 3,
      ratio: 2,
      cellMm: 8,
      gapMm: 3,
      intervalMm: defaultIntervalMm(ctx),
      labelMm: 1.5,
    }
  },
  build(ctx, o, scale) {
    const cell = Math.max(4, o.cellMm * scale)
    const gap = Math.max(2.5, o.gapMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const levels = o.energiesJPerMm2.map((e) => ({ e, combos: equalEnergyCombos(ctx, e, o) })).filter((l) => l.combos.length >= 2)
    if (!levels.length) throw new PatternFitError('no energy level can be reached with two different power/speed combinations on this machine')
    const eLabels = levels.map((l) => `E${fmtE(l.e)}`)
    const x0 = Math.max(...eLabels.map((t) => textWidthMm(t, lh))) + gap
    const rowH = cell + 2 * lh + gap + 1.5
    const cells: PatternCell[] = []
    levels.forEach((l, r) => {
      const y1 = -r * rowH
      l.combos.forEach((settings, c) => {
        const x = x0 + c * (cell + gap)
        cells.push({
          id: `e${r + 1}${String.fromCharCode(97 + c)}`,
          label: `${fmtPct(settings.powerPct)}% ${fmtFeed(settings.feedMmPerMin)}`,
          rectMm: rect(x, y1 - cell, x + cell, y1),
          settings,
          row: r,
          col: c,
          group: `E${l.e}`,
          extra: { targetEnergyJPerMm2: l.e },
        })
      })
    })
    return {
      title: this.title,
      options: { ...o, energiesJPerMm2: levels.map((l) => l.e) },
      cells,
      marks: [],
      draw(tp) {
        for (const k of cells) fillCell(tp, ctx, k)
        levels.forEach((_, r) => {
          const k = cells.find((c) => c.row === r)!
          label(tp, ctx, eLabels[r]!, x0 - gap, (k.rectMm.minYMm + k.rectMm.maxYMm - lh) / 2, lh, 'end')
        })
        for (const k of cells) {
          const cx = (k.rectMm.minXMm + k.rectMm.maxXMm) / 2
          label(tp, ctx, `S${fmtPct(k.settings.powerPct)}`, cx, k.rectMm.minYMm - 0.8 - lh, lh, 'middle')
          label(tp, ctx, `F${fmtFeed(k.settings.feedMmPerMin)}`, cx, k.rectMm.minYMm - 1.6 - 2 * lh, lh, 'middle')
        }
      },
    }
  },
}

// ── 3. Line-interval raster ───────────────────────────────────────────

export interface LineIntervalOptions {
  /** Line intervals (mm), left to right. */
  intervalsMm: number[]
  /** Scan axes, one row each, top to bottom. */
  scans: ScanAxis[]
  /** Power and feed shared by every cell (the energy per area changes with the interval). */
  powerPct: number
  feedMmPerMin: number
  cellMm: number
  gapMm: number
  labelMm: number
}

export const lineIntervalPattern: PatternGenerator<LineIntervalOptions> = {
  kind: 'line-interval',
  title: 'Line-interval raster',
  summary: 'One power and speed at several line intervals, scanned along X and along Y: striping, and how the oval spot changes with direction.',
  defaults(ctx) {
    const d = spotDiameterMm(ctx)
    const intervalsMm = [...new Set([0.4, 0.6, 0.8, 1, 1.3, 1.7].map((k) => Math.max(0.02, Math.round((d * k) / 0.005) * 0.005)))].map(r3)
    const mid = intervalsMm[Math.floor(intervalsMm.length / 2)]!
    const feed = tidyFeed(Math.min(6000, fillFeedCap(ctx, 'x'), fillFeedCap(ctx, 'y')))
    const s = fillForEnergy(ctx, materialMid(ctx), feed, mid, 'x')
    return { intervalsMm, scans: ['x', 'y'], powerPct: s.powerPct, feedMmPerMin: s.feedMmPerMin, cellMm: 6, gapMm: 2, labelMm: 1.5 }
  },
  build(ctx, o, scale) {
    const cell = Math.max(3, o.cellMm * scale)
    const gap = Math.max(1.5, o.gapMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const x0 = textWidthMm('X', lh) + gap
    const cells: PatternCell[] = []
    o.scans.forEach((scan, r) => {
      const y1 = -r * (cell + gap)
      o.intervalsMm.forEach((interval, c) => {
        const x = x0 + c * (cell + gap)
        const settings = fillSettings(ctx, o.powerPct / 100, o.feedMmPerMin, interval, scan)
        cells.push({
          id: `${scan}${c + 1}`,
          label: `${scan.toUpperCase()} ${interval} mm`,
          rectMm: rect(x, y1 - cell, x + cell, y1),
          settings,
          row: r,
          col: c,
          group: `scan-${scan}`,
          extra: { intervalOverSpot: r3(interval / spotDiameterMm(ctx)) },
        })
      })
    })
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (const k of cells) fillCell(tp, ctx, k)
        o.scans.forEach((scan, r) => {
          const k = cells.find((c) => c.row === r)!
          label(tp, ctx, scan.toUpperCase(), x0 - gap, (k.rectMm.minYMm + k.rectMm.maxYMm - lh) / 2, lh, 'end')
        })
        o.intervalsMm.forEach((interval, c) => {
          const k = cells.find((x) => x.col === c && x.row === 0)!
          label(tp, ctx, String(interval).replace(/^0\./, '.'), (k.rectMm.minXMm + k.rectMm.maxXMm) / 2, gap, lh, 'middle')
        })
      },
    }
  },
}

// ── 4. Sharp-cornered vector shapes ───────────────────────────────────

export interface CornersOptions {
  /** One row of shapes per feed (mm/min), top to bottom; power follows so the stroke energy is the same. */
  feedsMmPerMin: number[]
  /** Stroke energy on the centre line (incident J/mm²). */
  energyJPerMm2: number
  /** Apex angles of the V strokes (degrees). */
  vAnglesDeg: number[]
  shapeMm: number
  gapMm: number
  labelMm: number
}

type Path = [number, number][]

function shapes(size: number, vAngles: number[]): { id: string; label: string; paths: Path[]; corners: number[] }[] {
  const out: { id: string; label: string; paths: Path[]; corners: number[] }[] = []
  out.push({ id: 'square', label: 'Square', paths: [[[0, 0], [size, 0], [size, size], [0, size], [0, 0]]], corners: [90, 90, 90, 90] })
  const h = (size * Math.sqrt(3)) / 2
  out.push({ id: 'triangle', label: 'Triangle', paths: [[[0, 0], [size, 0], [size / 2, h], [0, 0]]], corners: [60, 60, 60] })
  const star: Path = []
  const R = size / 2
  const rIn = R * 0.381966
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5
    const rad = i % 2 === 0 ? R : rIn
    star.push([R + rad * Math.cos(a), R + rad * Math.sin(a)])
  }
  out.push({ id: 'star', label: 'Star', paths: [star], corners: [36, 36, 36, 36, 36] })
  for (const deg of vAngles) {
    const half = (deg * Math.PI) / 360
    const arm = size / Math.max(1, Math.cos(half) + Math.sin(half))
    const w = arm * Math.sin(half)
    const v = arm * Math.cos(half)
    out.push({ id: `v${deg}`, label: `V ${deg}°`, paths: [[[0, v], [w, 0], [2 * w, v]]], corners: [deg] })
  }
  const dash = size * 0.3
  const dashes: Path[] = []
  for (let i = 0; i < 3; i++) dashes.push([[0, i * (size / 3)], [dash, i * (size / 3)]])
  for (let i = 0; i < 3; i++) dashes.push([[dash + size * 0.2 + i * (size / 6), 0], [dash + size * 0.2 + i * (size / 6), dash * 2]])
  out.push({ id: 'dashes', label: 'Line ends', paths: dashes, corners: [] })
  return out
}

const pathBounds = (paths: Path[]) => {
  const xs = paths.flatMap((p) => p.map(([x]) => x))
  const ys = paths.flatMap((p) => p.map(([, y]) => y))
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

export const cornersPattern: PatternGenerator<CornersOptions> = {
  kind: 'corners',
  title: 'Sharp corners',
  summary: 'Outlines and V strokes at a fast and a slow feed with the same energy per stroke: scorch where the head slows into corners and line ends.',
  defaults(ctx) {
    const fast = tidyFeed(Math.min(6000, axisRate(ctx, 'x'), axisRate(ctx, 'y')))
    const slow = tidyFeed(Math.max(MIN_FEED_MM_PER_MIN, fast / 4))
    return { feedsMmPerMin: [fast, slow], energyJPerMm2: r3(materialMid(ctx) * 1.2), vAnglesDeg: [120, 90, 60, 30, 15], shapeMm: 10, gapMm: 4, labelMm: 1.5 }
  },
  build(ctx, o, scale) {
    const size = Math.max(5, o.shapeMm * scale)
    const gap = Math.max(2.5, o.gapMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const list = shapes(size, o.vAnglesDeg)
    const rowSettings = o.feedsMmPerMin.map((f) => lineForEnergy(ctx, o.energyJPerMm2, f))
    const rowLabels = rowSettings.map((s) => `F${fmtFeed(s.feedMmPerMin)} S${fmtPct(s.powerPct)}`)
    const rowH = size + lh + 2 * gap
    const cells: PatternCell[] = []
    const strokes: { settings: CellSettings; paths: Path[] }[] = []
    rowSettings.forEach((settings, r) => {
      const yBase = -r * rowH - size
      let x = 0
      list.forEach((sh, c) => {
        const b = pathBounds(sh.paths)
        const paths = sh.paths.map((p) => p.map(([px, py]) => [x + px - b.x0, yBase + py - b.y0] as [number, number]))
        strokes.push({ settings, paths })
        cells.push({
          id: `${sh.id}-${r + 1}`,
          label: `${sh.label} ${fmtFeed(settings.feedMmPerMin)}`,
          rectMm: rect(x, yBase, x + b.x1 - b.x0, yBase + b.y1 - b.y0),
          settings,
          row: r,
          col: c,
          group: sh.id,
          extra: { cornersDeg: sh.corners },
        })
        x += b.x1 - b.x0 + gap
      })
    })
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (const s of strokes) tp.strokes(s.paths, s.settings)
        rowSettings.forEach((_, r) => label(tp, ctx, rowLabels[r]!, 0, -r * rowH - size - gap - lh, lh))
      },
    }
  },
}

// ── 5. Small vs. large fill ───────────────────────────────────────────

export interface FillSizeOptions {
  /** Square sides (mm), left to right. */
  sizesMm: number[]
  powerPct: number
  feedMmPerMin: number
  intervalMm: number
  gapMm: number
  labelMm: number
}

export const fillSizePattern: PatternGenerator<FillSizeOptions> = {
  kind: 'fill-size',
  title: 'Small vs. large fill',
  summary: 'Squares of different sizes at the same settings: a large fill builds up heat that a small one doesn’t.',
  defaults(ctx) {
    const intervalMm = defaultIntervalMm(ctx)
    const feed = tidyFeed(Math.min(6000, fillFeedCap(ctx, 'x')))
    const s = fillForEnergy(ctx, materialMid(ctx), feed, intervalMm, 'x')
    return { sizesMm: [3, 8, 20], powerPct: s.powerPct, feedMmPerMin: s.feedMmPerMin, intervalMm, gapMm: 5, labelMm: 2 }
  },
  build(ctx, o, scale) {
    const gap = Math.max(3, o.gapMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const settings = fillSettings(ctx, o.powerPct / 100, o.feedMmPerMin, o.intervalMm, 'x')
    const cells: PatternCell[] = []
    let x = 0
    o.sizesMm.forEach((size0, i) => {
      const size = Math.max(2, size0 * (i === o.sizesMm.length - 1 ? scale : 1))
      cells.push({
        id: `fill${i + 1}`,
        label: `${r3(size)} mm`,
        rectMm: rect(x, 0, x + size, size),
        settings,
        col: i,
        group: 'same-settings',
        extra: { sideMm: r3(size), areaMm2: r3(size * size) },
      })
      x += size + gap
    })
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (const k of cells) fillCell(tp, ctx, k)
        for (const k of cells) label(tp, ctx, String(k.extra!.sideMm), (k.rectMm.minXMm + k.rectMm.maxXMm) / 2, -gap / 2 - lh, lh, 'middle')
        label(tp, ctx, `S${fmtPct(settings.powerPct)} F${fmtFeed(settings.feedMmPerMin)}`, 0, -gap - 2.5 * lh, lh)
      },
    }
  },
}

// ── 6. Registration and colour-card marks ─────────────────────────────

export interface MarksOptions {
  /** Tone wedge energies (incident J/mm²), light to dark. */
  wedgeJPerMm2: number[]
  patchMm: number
  /** Area left blank for a printed colour reference card (mm). */
  cardMm: { x: number; y: number }
  /** Scale bar length (mm), ticked every 10 mm. */
  scaleBarMm: number
  intervalMm: number
  labelMm: number
}

/** Fiducial fill: dark, at a slow feed so the overscan stays short. */
export function markFill(ctx: PatternContext, intervalMm: number): CellSettings {
  const feed = Math.min(1500, axisRate(ctx, 'x'))
  return fillForEnergy(ctx, materialRange(ctx).hi * 1.3, feed, intervalMm, 'x')
}

export const marksPattern: PatternGenerator<MarksOptions> = {
  kind: 'marks',
  title: 'Registration & colour card',
  summary: 'Corner fiducials, a tone wedge, a 10 mm scale bar and a space for a colour card, for finding and colour-correcting a photo of the burn.',
  defaults(ctx) {
    const { lo, hi } = materialRange(ctx)
    return {
      wedgeJPerMm2: geometric(lo * 0.8, hi * 1.5, 8).map((e) => Math.round(e * 1000) / 1000),
      patchMm: 5,
      cardMm: { x: 40, y: 25 },
      scaleBarMm: 50,
      intervalMm: defaultIntervalMm(ctx),
      labelMm: 1.5,
    }
  },
  build(ctx, o, scale) {
    const patch = Math.max(3, o.patchMm * scale)
    const lh = Math.max(1.2, o.labelMm * scale)
    const gap = 1.5
    const feed = tidyFeed(Math.min(3000, fillFeedCap(ctx, 'x')))
    const cells: PatternCell[] = o.wedgeJPerMm2.map((e, i) => {
      const x = i * (patch + gap)
      return {
        id: `tone${i + 1}`,
        label: `E${fmtE(e)}`,
        rectMm: rect(x, 0, x + patch, patch),
        settings: fillForEnergy(ctx, e, feed, o.intervalMm, 'x'),
        col: i,
        group: 'tone',
        extra: { targetEnergyJPerMm2: e },
      }
    })
    const wedgeW = o.wedgeJPerMm2.length * (patch + gap) - gap
    const cardW = Math.min(o.cardMm.x, Math.max(20, wedgeW)) * Math.max(scale, 0.5)
    const cardH = o.cardMm.y * Math.max(scale, 0.5)
    const cardY0 = patch + 3 * lh + 3
    const barY = -lh - 4
    const bar = Math.max(20, Math.min(o.scaleBarMm, Math.floor(wedgeW / 10) * 10 || 20))
    const line = labelSettings(ctx)
    const marks: PatternMark[] = [
      { id: 'card', kind: 'card', rectMm: rect(0, cardY0, cardW, cardY0 + cardH), centerMm: { xMm: r3(cardW / 2), yMm: r3(cardY0 + cardH / 2) }, settings: line },
      { id: 'scale', kind: 'scale', rectMm: rect(0, barY - 1, bar, barY + 1), centerMm: { xMm: r3(bar / 2), yMm: r3(barY) }, settings: line },
    ]
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks,
      draw(tp) {
        for (const k of cells) fillCell(tp, ctx, k)
        tp.strokes([[[0, cardY0], [cardW, cardY0], [cardW, cardY0 + cardH], [0, cardY0 + cardH], [0, cardY0]]], line)
        label(tp, ctx, 'CARD', cardW / 2, cardY0 + cardH / 2 - lh / 2, lh, 'middle')
        const ticks: Path[] = [[[0, barY], [bar, barY]]]
        for (let t = 0; t <= bar + 1e-9; t += 10) ticks.push([[t, barY - 1], [t, barY + 1]])
        tp.strokes(ticks, line)
        label(tp, ctx, `${bar} MM`, bar + 2, barY - lh / 2, lh)
        label(tp, ctx, 'LIGHT', 0, patch + 1, lh)
        label(tp, ctx, 'DARK', wedgeW, patch + 1, lh, 'end')
      },
    }
  },
}

export const PATTERNS = {
  grid: gridPattern,
  'equal-energy': equalEnergyPattern,
  'line-interval': lineIntervalPattern,
  corners: cornersPattern,
  'fill-size': fillSizePattern,
  marks: marksPattern,
} satisfies Record<PatternKind, PatternGenerator<any>>

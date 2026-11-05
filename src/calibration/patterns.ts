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
  lineSettings,
  materialMid,
  materialRange,
  overscanMm,
  powerAt,
  spotDiameterMm,
  strokeSigmaMm,
  type PatternContext,
} from './context.ts'
import { textStrokes, textWidthMm } from './font.ts'
import type { Toolpath } from './toolpath.ts'
import {
  PatternFitError,
  type CellSettings,
  type FocusZMode,
  type PatternCell,
  type PatternKind,
  type PatternMark,
  type PatternMeasures,
  type PatternPick,
  type ScanAxis,
} from './types.ts'

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
  /** What picking on the burn means. Default 'best-cell'. */
  pick?: PatternPick
  /** The profile value the pattern measures (BURN-47's measurement patterns). */
  measures?: PatternMeasures
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

// ── 7. Firing threshold (BURN-47) ─────────────────────────────────────

export interface FiringThresholdOptions {
  /** One line per power, % of $30, top to bottom (rising). */
  powersPct: number[]
  /** One slow feed for every line (mm/min), so a line marks as soon as the diode emits at all. */
  feedMmPerMin: number
  lineMm: number
  pitchMm: number
  labelMm: number
}

/**
 * Where the module's curve leaves zero, as a fraction of $30: the s of the
 * last point with zero power before the first point with power. 0 when the
 * curve rises from s = 0.
 */
export function curveFloor(ctx: PatternContext): number {
  const c = ctx.machine.powerCurve
  let floor = 0
  for (const p of c) {
    if (p.power > 0) break
    floor = p.s
  }
  return floor
}

/** A stroke's clickable record: the line from (x0, y) to (x1, y), as wide as the spot. */
const strokeRect = (ctx: PatternContext, x0: number, x1: number, y: number) => {
  const h = spotDiameterMm(ctx) / 2
  return rect(x0, y - h, x1, y + h)
}

export const firingThresholdPattern: PatternGenerator<FiringThresholdOptions> = {
  kind: 'firing-threshold',
  title: 'Firing threshold',
  summary:
    'Lines at rising low power, slowly. On a material that marks at very low power (dark card, black paper), the first line that marks is where the diode starts to emit: the bottom of the power curve.',
  pick: 'first-visible',
  measures: {
    on: 'LaserModule',
    field: 'powerCurve',
    profileField: 'MachineProfile.powerCurve',
    inContract: true,
    reads:
      'The S of the first line that marks is where powerCurve leaves power 0, on a material that marks at very low power. On a less sensitive one (wood, acrylic) a line a spot wide needs more than the diode’s first light to mark, so the reading is an upper bound.',
  },
  defaults(ctx) {
    const floor = curveFloor(ctx)
    // From well under the curve's current floor to well over it, so a real floor either side shows.
    const lo = Math.max(0.005, floor * 0.4)
    const hi = Math.min(1, Math.max(0.1, floor * 4))
    const pcts = [...new Set(linear(lo * 100, hi * 100, 20).map((p) => Math.round(p * 10) / 10))]
    // Slow enough that 1 % of full power puts the material's full-mark fluence on the centre line: a line
    // a spot wide loses heat sideways, so a line at the mark threshold barely shows (usually MIN_FEED).
    const p1 = ctx.machine.opticalPowerW * 0.01
    const v = (p1 / (materialRange(ctx).hi * Math.sqrt(2 * Math.PI) * strokeSigmaMm(ctx))) * 60
    const feed = tidyFeed(Math.max(MIN_FEED_MM_PER_MIN, Math.min(1000, v, axisRate(ctx, 'x'))))
    return { powersPct: pcts, feedMmPerMin: feed, lineMm: 20, pitchMm: 2.5, labelMm: 1.6 }
  },
  build(ctx, o, scale) {
    const lh = Math.max(1.2, o.labelMm * Math.max(scale, 0.75))
    const pitch = Math.max(lh + 0.4, o.pitchMm * scale)
    const len = Math.max(8, o.lineMm * scale)
    const gap = 1.5
    // One decimal on every label: the steps are fractions of a percent.
    const labels = o.powersPct.map((p) => p.toFixed(1))
    const x0 = Math.max(...labels.map((t) => textWidthMm(t, lh)), textWidthMm('S%', lh)) + gap
    const cells: PatternCell[] = o.powersPct.map((pct, i) => {
      const y = -i * pitch
      const settings = lineSettings(ctx, pct / 100, o.feedMmPerMin)
      return {
        id: `t${i + 1}`,
        label: `${settings.powerPct.toFixed(1)}% S${settings.s}`,
        rectMm: strokeRect(ctx, x0, x0 + len, y),
        settings,
        row: i,
        group: 'threshold',
        extra: { sFraction: r3(settings.s / ctx.machine.sMax), curveFloor: curveFloor(ctx) },
      }
    })
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (const k of cells) {
          const y = (k.rectMm.minYMm + k.rectMm.maxYMm) / 2
          tp.strokes([[[k.rectMm.minXMm, y], [k.rectMm.maxXMm, y]]], k.settings)
        }
        cells.forEach((k, i) => label(tp, ctx, labels[i]!, x0 - gap, (k.rectMm.minYMm + k.rectMm.maxYMm - lh) / 2, lh, 'end'))
        label(tp, ctx, 'S%', x0 - gap, pitch * 0.5 + 0.5, lh, 'end')
        label(tp, ctx, `F${fmtFeed(o.feedMmPerMin)}`, x0, pitch * 0.5 + 0.5, lh)
      },
    }
  },
}

// ── 8. Focus height (BURN-47) ─────────────────────────────────────────

/** Largest Z offset from focus the focus pattern accepts (mm), either way. */
export const MAX_FOCUS_OFFSET_MM = 5
/** Smallest step between neighbouring offsets (mm). */
export const MIN_FOCUS_STEP_MM = 0.1

export interface FocusHeightOptions {
  /**
   * Z offsets from the focus the head is at when the job starts (mm, + = head
   * up, away from the work), burned top to bottom in this order.
   */
  zOffsetsMm: number[]
  /**
   * pause (default): the job stops (M0) before each line and the operator moves
   * the head; no Z is commanded, so it is safe on frames with manual focus.
   * z-axis: small relative steps (G91 G0 Z…) on a motorised Z; the job ends
   * where it started.
   */
  zMode: FocusZMode
  powerPct: number
  feedMmPerMin: number
  lineMm: number
  pitchMm: number
  labelMm: number
}

const fmtZ = (z: number) => (Math.abs(z) < 1e-9 ? '0' : `${z > 0 ? '+' : '-'}${Math.abs(z).toFixed(Math.abs(z * 10) % 1 > 1e-6 ? 2 : 1)}`)

/** Throws unless the offsets are small, distinct and stepped at least MIN_FOCUS_STEP_MM apart. */
export function checkFocusOffsets(z: readonly number[]): void {
  if (!z.length) throw new RangeError('Focus height needs at least one Z offset')
  for (const v of z)
    if (!Number.isFinite(v) || Math.abs(v) > MAX_FOCUS_OFFSET_MM) throw new RangeError(`Z offset ${v} mm is outside ±${MAX_FOCUS_OFFSET_MM} mm of focus`)
  const sorted = [...z].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]! - sorted[i - 1]! < MIN_FOCUS_STEP_MM - 1e-9) throw new RangeError(`Z offsets must be at least ${MIN_FOCUS_STEP_MM} mm apart`)
}

export const focusHeightPattern: PatternGenerator<FocusHeightOptions> = {
  kind: 'focus-height',
  title: 'Focus height',
  summary:
    'One line per Z offset around focus, labelled in mm (+ = head up). The thinnest line is best focus; the widths give spot size against defocus. Pauses for you to move the head unless set to a motorised Z.',
  pick: 'thinnest',
  measures: {
    on: 'LaserModule',
    field: 'spot',
    profileField: 'MachineProfile.spot',
    inContract: true,
    reads: 'The thinnest line marks best focus; its width is about the spot’s 1/e² diameter (spot.minorDiameterMm across the line). The other widths give spot size against defocus.',
  },
  defaults(ctx) {
    const feed = tidyFeed(Math.max(MIN_FEED_MM_PER_MIN, Math.min(1500, axisRate(ctx, 'x'))))
    // The material's full-mark fluence (as the labels): a line a spot wide at mid fluence barely shows.
    const s = lineForEnergy(ctx, materialRange(ctx).hi, feed)
    return {
      zOffsetsMm: linear(2, -2, 9).map((z) => Math.round(z * 100) / 100),
      zMode: 'pause' as FocusZMode,
      powerPct: s.powerPct,
      feedMmPerMin: tidyFeed(s.feedMmPerMin),
      lineMm: 20,
      pitchMm: 3,
      labelMm: 1.6,
    }
  },
  build(ctx, o, scale) {
    checkFocusOffsets(o.zOffsetsMm)
    if (o.zMode !== 'pause' && o.zMode !== 'z-axis') throw new RangeError(`zMode must be pause or z-axis, not ${String(o.zMode)}`)
    const lh = Math.max(1.2, o.labelMm * Math.max(scale, 0.75))
    const pitch = Math.max(lh + 0.6, o.pitchMm * scale)
    const len = Math.max(8, o.lineMm * scale)
    const gap = 1.5
    const settings = lineSettings(ctx, o.powerPct / 100, o.feedMmPerMin)
    const labels = o.zOffsetsMm.map(fmtZ)
    const x0 = Math.max(...labels.map((t) => textWidthMm(t, lh)), textWidthMm('Z MM', lh)) + gap
    const cells: PatternCell[] = o.zOffsetsMm.map((z, i) => ({
      id: `z${i + 1}`,
      label: `Z ${fmtZ(z)} mm`,
      rectMm: strokeRect(ctx, x0, x0 + len, -i * pitch),
      settings,
      row: i,
      group: 'focus',
      extra: { zOffsetMm: z },
    }))
    const where = (z: number) => (Math.abs(z) < 1e-9 ? 'at focus' : `${Math.abs(z)} mm ${z > 0 ? 'above' : 'below'} focus`)
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        // Labels first, at the focus the job starts at, so they read whatever the lines do.
        cells.forEach((k, i) => label(tp, ctx, labels[i]!, x0 - gap, -i * pitch - lh / 2, lh, 'end'))
        label(tp, ctx, 'Z MM', x0 - gap, pitch * 0.5 + 0.5, lh, 'end')
        label(tp, ctx, `S${fmtPct(settings.powerPct)} F${fmtFeed(settings.feedMmPerMin)}`, x0, pitch * 0.5 + 0.5, lh)
        let z = 0
        cells.forEach((k, i) => {
          const target = o.zOffsetsMm[i]!
          const dz = Math.round((target - z) * 1000) / 1000
          if (o.zMode === 'z-axis') tp.zStep(dz)
          else if (dz !== 0)
            tp.pause(`move the head ${Math.abs(dz)} mm ${dz > 0 ? 'UP' : 'DOWN'} to Z ${fmtZ(target)} mm (${where(target)}), then resume`)
          z = target
          const y = -i * pitch
          tp.strokes([[[x0, y], [x0 + len, y]]], k.settings)
        })
        // Back to the starting focus before anything else is burned.
        if (o.zMode === 'z-axis') tp.zStep(-z)
        else if (Math.abs(z) > 1e-9) tp.pause(`move the head ${Math.abs(z)} mm ${z > 0 ? 'DOWN' : 'UP'} back to focus, then resume`)
      },
    }
  },
}

// ── 9. Scan offset (BURN-47) ──────────────────────────────────────────

export interface ScanOffsetOptions {
  /** One strip per feed (mm/min), top to bottom. */
  feedsMmPerMin: number[]
  /** Strip length along the scan (X) and height across it (mm). */
  stripMm: number
  stripHeightMm: number
  /** Scan line spacing: wide enough that single lines and their ends stay apart (mm). */
  intervalMm: number
  /** Centre-line energy of each scan line (incident J/mm²); power follows the feed. */
  energyJPerMm2: number
  gapMm: number
  labelMm: number
}

export const scanOffsetPattern: PatternGenerator<ScanOffsetOptions> = {
  kind: 'scan-offset',
  title: 'Scan offset',
  summary:
    'Bidirectional strips at rising speed with sparse lines and ticks at the programmed ends. Forward and back lines end apart by the scan offset at that speed.',
  pick: 'shift',
  measures: {
    on: 'MachineFrame',
    field: 'scanOffsetMm',
    inContract: false,
    reads:
      'At each feed, the distance between where forward and back lines end at the same strip edge (the comb at either end; the ticks mark the programmed edge). The contract has no field for it yet: scanOffsetMm per feed is the proposed name.',
  },
  defaults(ctx) {
    const cap = fillFeedCap(ctx, 'x')
    const slow = Math.max(MIN_FEED_MM_PER_MIN, Math.min(1000, cap / 8))
    const feeds = [...new Set(geometric(slow, cap, 5).map(tidyFeed))]
    const interval = Math.min(0.5, Math.max(0.2, Math.round((spotDiameterMm(ctx) * 4) / 0.05) * 0.05))
    return { feedsMmPerMin: feeds, stripMm: 20, stripHeightMm: 3, intervalMm: r3(interval), energyJPerMm2: r3(materialMid(ctx)), gapMm: 4, labelMm: 1.6 }
  },
  build(ctx, o, scale) {
    const lh = Math.max(1.2, o.labelMm * Math.max(scale, 0.75))
    const len = Math.max(10, o.stripMm * scale)
    const h = Math.max(o.intervalMm * 4, o.stripHeightMm * scale)
    const gap = Math.max(3.5, o.gapMm * scale)
    const labels = o.feedsMmPerMin.map((f) => `F${fmtFeed(f)}`)
    const x0 = Math.max(...labels.map((t) => textWidthMm(t, lh))) + 2
    const width = Math.sqrt(2 * Math.PI) * strokeSigmaMm(ctx)
    const cells: PatternCell[] = o.feedsMmPerMin.map((feed, r) => {
      const p = o.energyJPerMm2 * (feed / 60) * width
      const fraction = Math.min(1, Math.max(DEFAULT_MIN_POWER_FRACTION, fractionForPower(ctx, Math.min(p, ctx.machine.opticalPowerW)) ?? 1))
      const y1 = -r * (h + gap)
      return {
        id: `f${r + 1}`,
        label: `${fmtFeed(feed)} mm/min`,
        rectMm: rect(x0, y1 - h, x0 + len, y1),
        settings: fillSettings(ctx, fraction, feed, o.intervalMm, 'x'),
        row: r,
        group: 'scan-x',
        extra: { feedMmPerMin: feed },
      }
    })
    const tick = Math.min(1.2, gap / 2 - 0.6)
    return {
      title: this.title,
      options: { ...o },
      cells,
      marks: [],
      draw(tp) {
        for (const k of cells) fillCell(tp, ctx, k)
        // Ticks across the scan at the programmed ends, above and below each strip: vector strokes along Y, which the X scan lag doesn't move.
        const ticks: Path[] = []
        for (const k of cells) {
          const { minXMm: a, maxXMm: b, minYMm: lo, maxYMm: hi } = k.rectMm
          for (const x of [a, b]) {
            ticks.push([[x, hi + 0.4], [x, hi + 0.4 + tick]])
            ticks.push([[x, lo - 0.4], [x, lo - 0.4 - tick]])
          }
        }
        tp.strokes(ticks, labelSettings(ctx))
        cells.forEach((k, r) => label(tp, ctx, labels[r]!, x0 - 2, (k.rectMm.minYMm + k.rectMm.maxYMm - lh) / 2, lh, 'end'))
        label(tp, ctx, 'SCAN X', x0, 0.4 + tick + 1, lh)
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
  'firing-threshold': firingThresholdPattern,
  'focus-height': focusHeightPattern,
  'scan-offset': scanOffsetPattern,
} satisfies Record<PatternKind, PatternGenerator<any>>

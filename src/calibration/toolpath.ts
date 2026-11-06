// SPDX-License-Identifier: MIT
// Toolpath builder: writes GRBL G-code and, in lockstep, the JobModel the
// parser (COD-263) makes of it: same moves, source lines and modal state. The
// app checks the two agree for every catalog machine (aria-burn job.rs).
//
// Dialect: G21 G90, M4 dynamic power, explicit G0/G1 on every move, words
// written only when they change, coordinates to 0.001 mm and S to 0.1.
//
// Used by the calibration patterns (BURN-32) and SVG import (BURN-51). It only
// needs a small context: the machine profile, the bed and the rapid rate.
//
// Passes: comments in LightBurn's layer and pass forms ("Layer C00",
// "… @ … mm/…", "Pass n") split the job the way the parser's passes.rs does,
// and without them a job whose burned geometry is one block repeated is split
// into repeats, with the parser's multi-pass warning. Calibration patterns
// write none of those comments and repeat no geometry, so they stay one pass.
//
// The focus pattern (BURN-47) also writes program pauses (M0) or relative Z
// steps (G91 G0 Z…, then G90). The v1 parser ignores both with a warning, once
// per code at its first line; the job model carries the same warnings.

import { CONTRACT_VERSION, type BoundsMm, type Diagnostic, type JobModel, type LaserMode, type Move } from '../contract/index.ts'
import type { MachineProfile, Pass } from '../contract/index.ts'
import { PatternFitError, type CellSettings, type ScanAxis } from './types.ts'

/** What the toolpath needs to know about the machine. A PatternContext is one. */
export interface ToolpathContext {
  machine: MachineProfile
  /** Usable bed (mm). Moves outside it throw, unless `checkBed` is off. */
  bedMm: { x: number; y: number }
  /** Rapid rate for the time estimate (mm/min). Default: the slower of $110/$111. */
  rapidRateMmPerMin?: number
}

export interface ToolpathOptions {
  /** Build without the bed check, to find an extent in local coordinates before placing it. */
  measure?: boolean
  /** Throw PatternFitError on a move outside the bed. Default true; SVG import reports instead. */
  checkBed?: boolean
}

/** A pass boundary from a comment, as the parser's passes.rs `Marker` reads it. */
export interface PassMarker {
  /** Index of the first move after the comment. */
  moveIndex: number
  line: number
  /** Set for a `Layer …` comment: the layer name. */
  layer?: string
}

/** The parser's reading of a comment (passes.rs `Marker::from_comment`), without the leading `;`. */
export function passMarker(comment: string, moveIndex: number, line: number): PassMarker | null {
  const text = comment.trim()
  const lower = text.toLowerCase()
  if (lower.startsWith('layer') && (lower[5] === ' ' || lower[5] === ':')) {
    const name = text.slice(5).replace(/^[ :]+/, '').trim()
    return { moveIndex, line, layer: name }
  }
  const settings = lower.includes(' @ ') && lower.includes('mm/')
  const pass = lower.startsWith('pass ') && /^[0-9]/.test(lower.slice(5))
  return settings || pass ? { moveIndex, line } : null
}

/** One beam-on run along the scan axis, from `a0` to `a1` (mm on that axis). */
export interface Span {
  a0: number
  a1: number
  s: number
}

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000
  return (Object.is(r, -0) ? 0 : r).toFixed(3).replace(/\.?0+$/, '')
}
const fmtS = (v: number): string => (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')
const snap = (v: number) => Number(fmt(v))

/** Rust's f64::round: half away from zero. */
const roundAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v))

/** Burned move ends quantised to 0.1 µm, as passes.rs compares them. */
function burnedKeys(moves: readonly Move[], from = 0, to = moves.length): { index: number[]; keys: string[] } {
  const index: number[] = []
  const keys: string[] = []
  for (let i = from; i < to; i++) {
    const m = moves[i]!
    if (m.kind === 'g1' && m.laser !== 'off' && m.s > 0) {
      index.push(i - from)
      keys.push(`${roundAway(m.xMm * 1e4)},${roundAway(m.yMm * 1e4)}`)
    }
  }
  return { index, keys }
}

/** Pass starts (excluding 0) when the burned geometry is one block repeated (passes.rs `repeated_blocks`). */
function repeatedBlocks(moves: readonly Move[]): number[] {
  const { index, keys } = burnedKeys(moves)
  const n = keys.length
  let block = 0
  for (let b = 1; b <= Math.floor(n / 2) && !block; b++) {
    if (n % b !== 0) continue
    let ok = true
    for (let k = b; k < n && ok; k++) ok = keys[k] === keys[k % b]
    if (ok) block = b
  }
  if (!block) return []
  const out: number[] = []
  for (let t = 1; t < n / block; t++) out.push(index[t * block - 1]! + 1)
  return out
}

/**
 * The parser's pass split (passes.rs `split`): passes covering `moves`, and
 * where the first repeat starts and how many times the most repeated burned
 * geometry is burned, when some pass repeats another.
 */
export function splitPasses(moves: readonly Move[], markers: readonly PassMarker[]): { passes: Pass[]; repeated: { line: number; count: number } | null } {
  if (!moves.length) return { passes: [], repeated: null }
  const starts: { first: number; label?: string }[] = [{ first: 0 }]
  let layer: string | undefined
  for (const m of markers) {
    if (m.layer !== undefined) layer = m.layer
    if (m.moveIndex >= moves.length) continue
    const last = starts[starts.length - 1]!
    if (last.first === m.moveIndex) {
      if (layer === undefined) delete last.label
      else last.label = layer
    } else starts.push(layer === undefined ? { first: m.moveIndex } : { first: m.moveIndex, label: layer })
  }
  if (starts.length === 1) for (const s of repeatedBlocks(moves)) starts.push({ first: s })

  const passes: Pass[] = starts.map((s, index) => {
    const end = starts[index + 1]?.first ?? moves.length
    return { index, firstMove: s.first, moveCount: end - s.first, ...(s.label !== undefined ? { label: s.label } : {}) }
  })
  const keys = passes.map((p) => burnedKeys(moves, p.firstMove, p.firstMove + p.moveCount).keys.join(';'))
  let repeated: { line: number; count: number } | null = null
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!
    if (!key || keys.slice(0, i).includes(key)) continue
    const copies: number[] = []
    for (let j = i + 1; j < keys.length; j++) if (keys[j] === key) copies.push(j)
    if (!copies.length) continue
    const p = passes[copies[0]!]!
    const first = burnedKeys(moves, p.firstMove, p.firstMove + p.moveCount).index[0]
    const line = first === undefined ? 0 : moves[p.firstMove + first]!.line
    const count = copies.length + 1
    repeated = repeated ? { line: Math.min(repeated.line, line), count: Math.max(repeated.count, count) } : { line, count }
  }
  return { passes, repeated }
}

/**
 * Builds G-code and its JobModel in lockstep. `T` is an optional tag recorded
 * for every line written (SVG import maps lines back to layers and paths).
 */
export class Toolpath<T = never> {
  private readonly lines: string[] = []
  private readonly tags: (T | null)[] = []
  private tag: T | null = null
  private readonly markers: PassMarker[] = []
  private readonly moves: Move[] = []
  private x = 0
  private y = 0
  private feed = 0
  private s = 0
  private laser: LaserMode = 'off'
  private timeS = 0
  private readonly rapidRate: number
  /** Added to every coordinate (patterns draw in local mm, then move to their origin). */
  private ox = 0
  private oy = 0
  private readonly ext = { minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity }
  private readonly burnExt = { minXMm: Infinity, minYMm: Infinity, maxXMm: -Infinity, maxYMm: -Infinity }
  private readonly diagnostics: Diagnostic[] = []
  /** Net relative Z written so far (mm); the focus pattern returns it to 0. */
  private zNet = 0

  private readonly checkBed: boolean

  constructor(
    private readonly ctx: ToolpathContext,
    options: ToolpathOptions = {},
  ) {
    this.rapidRate = ctx.rapidRateMmPerMin ?? Math.min(ctx.machine.maxRateMmPerMin.x, ctx.machine.maxRateMmPerMin.y)
    this.checkBed = !options.measure && (options.checkBed ?? true)
  }

  /** The tag recorded for the lines written from now on (null for none). */
  setTag(tag: T | null): void {
    this.tag = tag
  }

  /** One tag per G-code line, in order (index = line - 1). */
  lineTags(): (T | null)[] {
    return [...this.tags]
  }

  private emit(line: string): void {
    this.lines.push(line)
    this.tags.push(this.tag)
  }

  setOffset(dx: number, dy: number): void {
    this.ox = dx
    this.oy = dy
  }

  /** Every point visited (start excluded), in the coordinates written. */
  get extent(): { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number } {
    return { ...this.ext }
  }

  /** Every point the beam is on between. */
  get burnExtent(): { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number } {
    return { ...this.burnExt }
  }

  private grow(b: { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number }, x: number, y: number): void {
    b.minXMm = Math.min(b.minXMm, x)
    b.minYMm = Math.min(b.minYMm, y)
    b.maxXMm = Math.max(b.maxXMm, x)
    b.maxYMm = Math.max(b.maxYMm, y)
  }

  comment(text: string): void {
    const t = text.replace(/[\r\n]/g, ' ')
    this.emit(`; ${t}`)
    const marker = passMarker(t, this.moves.length, this.lines.length)
    if (marker) this.markers.push(marker)
  }

  /** Units, absolute mode and M4 with the beam off. */
  start(): void {
    this.emit('G21 G90')
    this.emit('M4 S0')
    this.laser = 'm4'
    this.s = 0
  }

  /** Beam off and program end. */
  end(): void {
    this.emit('M5 S0')
    this.laser = 'off'
    this.s = 0
    this.emit('M2')
  }

  private check(x: number, y: number): void {
    if (!this.checkBed) return
    const { x: bx, y: by } = this.ctx.bedMm
    if (x < -1e-9 || y < -1e-9 || x > bx + 1e-9 || y > by + 1e-9)
      throw new PatternFitError(`move to (${fmt(x)}, ${fmt(y)}) mm is outside the ${fmt(bx)} × ${fmt(by)} mm bed`)
  }

  /** The parser's v1 warning for a code, once, at the line just written. */
  private warnOnce(code: string, message: string): void {
    if (!this.diagnostics.some((d) => d.code === code)) this.diagnostics.push({ severity: 'warning', code, message, line: this.lines.length })
  }

  /**
   * Program pause with the beam off: M5, a comment saying what to do, M0, then
   * M4 S0 again. The operator resumes (cycle start) when done.
   */
  pause(instruction: string): void {
    this.emit('M5 S0')
    this.laser = 'off'
    this.s = 0
    this.comment(`PAUSE: ${instruction}`)
    this.emit('M0')
    this.warnOnce('ignored-pause', 'Program pause (M0/M1) is ignored')
    this.emit('M4 S0')
    this.laser = 'm4'
  }

  /** A relative Z step (mm, + = head up), as a rapid with the beam off; back to absolute mode after. */
  zStep(dzMm: number): void {
    const dz = snap(dzMm)
    if (dz === 0) return
    this.emit(`G91 G0 Z${fmt(dz)}`)
    this.warnOnce('ignored-z', 'Z moves are ignored in v1')
    this.emit('G90')
    this.zNet = snap(this.zNet + dz)
  }

  /** Net relative Z written so far (mm). */
  get zOffsetMm(): number {
    return this.zNet
  }

  rapid(x: number, y: number): void {
    const [nx, ny] = [snap(x + this.ox), snap(y + this.oy)]
    if (nx === this.x && ny === this.y) return
    this.check(nx, ny)
    this.emit(`G0 X${fmt(nx)} Y${fmt(ny)}`)
    this.timeS += Math.hypot(nx - this.x, ny - this.y) / (this.rapidRate / 60)
    this.push('g0', nx, ny)
  }

  /** G1 to (x, y) at `feed` and S. */
  cut(x: number, y: number, feed: number, s: number): void {
    const [nx, ny] = [snap(x + this.ox), snap(y + this.oy)]
    const f = Math.round(feed)
    const ns = Math.round(s * 10) / 10
    if (nx === this.x && ny === this.y) return
    this.check(nx, ny)
    let line = `G1 X${fmt(nx)} Y${fmt(ny)}`
    if (f !== this.feed) line += ` F${f}`
    if (ns !== this.s) line += ` S${fmtS(ns)}`
    this.emit(line)
    this.feed = f
    this.s = ns
    this.timeS += Math.hypot(nx - this.x, ny - this.y) / (f / 60)
    this.push('g1', nx, ny)
  }

  private push(kind: 'g0' | 'g1', x: number, y: number): void {
    this.moves.push({ kind, xMm: x, yMm: y, feedMmPerMin: this.feed, s: this.s, laser: this.laser, line: this.lines.length })
    this.grow(this.ext, x, y)
    if (kind === 'g1' && this.laser !== 'off' && this.s > 0) {
      this.grow(this.burnExt, this.x, this.y)
      this.grow(this.burnExt, x, y)
    }
    this.x = x
    this.y = y
  }

  /** Vector strokes at a line setting; each stroke starts with a rapid. */
  strokes(paths: readonly (readonly [number, number])[][], settings: CellSettings): void {
    for (const p of paths) {
      if (p.length < 2) continue
      this.rapid(p[0]![0], p[0]![1])
      for (let i = 1; i < p.length; i++) this.cut(p[i]![0], p[i]![1], settings.feedMmPerMin, settings.s)
    }
  }

  /**
   * Bidirectional raster over `spans` along `axis`, one scan line every
   * `intervalMm` from `c0` to `c1` across it, at one feed. Each line runs at
   * S0 for `overscanMm` before the first span and after the last, so the head
   * is at speed wherever the beam is on; S changes between spans don't slow it
   * (GRBL laser mode, $32=1). Gaps between spans run at S0.
   */
  raster(axis: ScanAxis, spans: readonly Span[], c0: number, c1: number, intervalMm: number, feed: number, overscanMm: number): void {
    if (!spans.length) return
    const sorted = [...spans].sort((a, b) => a.a0 - b.a0)
    const lo = sorted[0]!.a0 - overscanMm
    const hi = sorted[sorted.length - 1]!.a1 + overscanMm
    const n = Math.max(1, Math.floor((c1 - c0) / intervalMm + 1e-6) + 1)
    const pt = (a: number, c: number): [number, number] => (axis === 'x' ? [a, c] : [c, a])
    for (let i = 0; i < n; i++) {
      const c = c0 + i * intervalMm
      const forward = i % 2 === 0
      this.rapid(...pt(forward ? lo : hi, c))
      const order = forward ? sorted : [...sorted].reverse()
      for (const span of order) {
        const [from, to] = forward ? [span.a0, span.a1] : [span.a1, span.a0]
        this.cut(...pt(from, c), feed, 0)
        this.cut(...pt(to, c), feed, span.s)
      }
      this.cut(...pt(forward ? hi : lo, c), feed, 0)
    }
  }

  /** Raster fill of one rectangle with a fill setting. */
  fillRect(r: BoundsMm, settings: CellSettings, overscanMm: number): void {
    const axis = settings.scan ?? 'x'
    const interval = settings.intervalMm!
    const [a0, a1, c0, c1] = axis === 'x' ? [r.minXMm, r.maxXMm, r.minYMm, r.maxYMm] : [r.minYMm, r.maxYMm, r.minXMm, r.maxXMm]
    this.raster(axis, [{ a0, a1, s: settings.s }], c0, c1, interval, settings.feedMmPerMin, overscanMm)
  }

  get estimatedTimeS(): number {
    return Math.round(this.timeS * 10) / 10
  }

  gcode(): string {
    return this.lines.join('\n') + '\n'
  }

  job(name: string): JobModel {
    const moves = this.moves.map((m) => ({ ...m }))
    const all = { minXMm: 0, minYMm: 0, maxXMm: 0, maxYMm: 0 }
    let burn: BoundsMm | null = null
    let px = 0
    let py = 0
    for (const m of moves) {
      all.minXMm = Math.min(all.minXMm, m.xMm)
      all.minYMm = Math.min(all.minYMm, m.yMm)
      all.maxXMm = Math.max(all.maxXMm, m.xMm)
      all.maxYMm = Math.max(all.maxYMm, m.yMm)
      if (m.kind === 'g1' && m.laser !== 'off' && m.s > 0) {
        const b: BoundsMm = burn ?? { minXMm: px, minYMm: py, maxXMm: px, maxYMm: py }
        burn = {
          minXMm: Math.min(b.minXMm, px, m.xMm),
          minYMm: Math.min(b.minYMm, py, m.yMm),
          maxXMm: Math.max(b.maxXMm, px, m.xMm),
          maxYMm: Math.max(b.maxYMm, py, m.yMm),
        }
      }
      px = m.xMm
      py = m.yMm
    }
    const { passes, repeated } = splitPasses(moves, this.markers)
    const diagnostics = this.diagnostics.map((d) => ({ ...d }))
    if (repeated)
      diagnostics.push({
        severity: 'warning',
        code: 'multi-pass',
        message: `Same geometry is burned in ${repeated.count} passes; v1 simulates all passes as one deposit, so multi-pass jobs will over-darken`,
        line: repeated.line,
      })
    return {
      contractVersion: CONTRACT_VERSION,
      source: { kind: 'file', name, lineCount: this.lines.length },
      startMm: { xMm: 0, yMm: 0 },
      moves,
      passes,
      bounds: all,
      burnBounds: burn,
      diagnostics,
    }
  }
}

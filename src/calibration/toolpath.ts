// SPDX-License-Identifier: MIT
// Toolpath builder: writes GRBL G-code and, in lockstep, the JobModel the
// parser (COD-263) makes of it: same moves, source lines and modal state. The
// app checks the two agree for every catalog machine (aria-burn job.rs).
//
// Dialect: G21 G90, M4 dynamic power, explicit G0/G1 on every move, words
// written only when they change, coordinates to 0.001 mm and S to 0.1. No
// comment uses LightBurn's pass forms ("… @ … mm/…", "Pass n"), so the parser
// keeps the job as one pass.
//
// The focus pattern (BURN-47) also writes program pauses (M0) or relative Z
// steps (G91 G0 Z…, then G90). The v1 parser ignores both with a warning, once
// per code at its first line; the job model carries the same warnings.

import { CONTRACT_VERSION, type BoundsMm, type Diagnostic, type JobModel, type LaserMode, type Move } from '../contract/index.ts'
import type { PatternContext } from './context.ts'
import { PatternFitError, type CellSettings, type ScanAxis } from './types.ts'

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

export class Toolpath {
  private readonly lines: string[] = []
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

  /**
   * `measure` builds without the bed check, to find a pattern's extent in its
   * local coordinates before it is placed.
   */
  constructor(
    private readonly ctx: PatternContext,
    private readonly measure = false,
  ) {
    this.rapidRate = Math.min(ctx.machine.maxRateMmPerMin.x, ctx.machine.maxRateMmPerMin.y)
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
    this.lines.push(`; ${text.replace(/[\r\n]/g, ' ')}`)
  }

  /** Units, absolute mode and M4 with the beam off. */
  start(): void {
    this.lines.push('G21 G90')
    this.lines.push('M4 S0')
    this.laser = 'm4'
    this.s = 0
  }

  /** Beam off and program end. */
  end(): void {
    this.lines.push('M5 S0')
    this.laser = 'off'
    this.s = 0
    this.lines.push('M2')
  }

  private check(x: number, y: number): void {
    if (this.measure) return
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
    this.lines.push('M5 S0')
    this.laser = 'off'
    this.s = 0
    this.comment(`PAUSE: ${instruction}`)
    this.lines.push('M0')
    this.warnOnce('ignored-pause', 'Program pause (M0/M1) is ignored')
    this.lines.push('M4 S0')
    this.laser = 'm4'
  }

  /** A relative Z step (mm, + = head up), as a rapid with the beam off; back to absolute mode after. */
  zStep(dzMm: number): void {
    const dz = snap(dzMm)
    if (dz === 0) return
    this.lines.push(`G91 G0 Z${fmt(dz)}`)
    this.warnOnce('ignored-z', 'Z moves are ignored in v1')
    this.lines.push('G90')
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
    this.lines.push(`G0 X${fmt(nx)} Y${fmt(ny)}`)
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
    this.lines.push(line)
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
    return {
      contractVersion: CONTRACT_VERSION,
      source: { kind: 'file', name, lineCount: this.lines.length },
      startMm: { xMm: 0, yMm: 0 },
      moves,
      passes: moves.length ? [{ index: 0, firstMove: 0, moveCount: moves.length }] : [],
      bounds: all,
      burnBounds: burn,
      diagnostics: this.diagnostics.map((d) => ({ ...d })),
    }
  }
}

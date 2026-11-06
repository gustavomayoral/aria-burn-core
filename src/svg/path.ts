// SPDX-License-Identifier: MIT
// SVG path data and basic shapes as exact segments (lines, cubics, elliptical
// arcs) in user units, and their flattening to polylines in mm (BURN-50).
//
// Curves are kept exact until the element's full transform is known and are
// flattened after it, so the tolerance holds in output mm whatever the scale:
// an affine map takes a cubic to a cubic and an elliptical arc to an elliptical
// arc, so transforming the control points (or the arc's centre and axis
// vectors) first is exact.

import { apply, applyLinear, type Matrix } from './matrix.ts'

export type Segment =
  | { kind: 'line'; x: number; y: number }
  | { kind: 'cubic'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  /** P(t) = (cx, cy) + (ux, uy)·cos t + (vx, vy)·sin t, for t from t0 to t0 + dt. */
  | { kind: 'arc'; cx: number; cy: number; ux: number; uy: number; vx: number; vy: number; t0: number; dt: number }

export interface RawSubpath {
  x0: number
  y0: number
  segments: Segment[]
  closed: boolean
}

export interface ParsedPath {
  subpaths: RawSubpath[]
  /** Set when the data has an error; the path is kept up to the error, as SVG renders it. */
  error: string | null
}

const ARG_COUNT: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }

class Scanner {
  pos = 0
  constructor(readonly s: string) {}
  skip(): void {
    const s = this.s
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) this.pos++
      else break
    }
  }
  done(): boolean {
    this.skip()
    return this.pos >= this.s.length
  }
  peekCommand(): string | null {
    this.skip()
    const c = this.s[this.pos]
    return c !== undefined && /[MmLlHhVvCcSsQqTtAaZz]/.test(c) ? c : null
  }
  number(): number | null {
    this.skip()
    const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
    re.lastIndex = this.pos
    const m = re.exec(this.s)
    if (!m) return null
    this.pos = re.lastIndex
    return Number(m[0])
  }
  flag(): number | null {
    this.skip()
    const c = this.s[this.pos]
    if (c !== '0' && c !== '1') return null
    this.pos++
    return c === '1' ? 1 : 0
  }
}

export function parsePathData(d: string): ParsedPath {
  const sc = new Scanner(d)
  const subpaths: RawSubpath[] = []
  let current: RawSubpath | null = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  // Reflection points for S/T.
  let lastCubic: [number, number] | null = null
  let lastQuad: [number, number] | null = null
  let cmd: string | null = null
  let first = true

  const ensureSubpath = () => {
    if (!current) {
      current = { x0: x, y0: y, segments: [], closed: false }
      subpaths.push(current)
      startX = x
      startY = y
    }
    return current
  }
  const finish = (error: string | null): ParsedPath => ({
    subpaths: subpaths.filter((s) => s.segments.length > 0),
    error,
  })

  while (!sc.done()) {
    const next = sc.peekCommand()
    if (next) {
      sc.pos++
      cmd = next
    } else if (cmd === null || cmd === 'z' || cmd === 'Z') {
      return finish(`unexpected "${sc.s.slice(sc.pos, sc.pos + 8)}"`)
    } else if (cmd === 'm') cmd = 'l'
    else if (cmd === 'M') cmd = 'L'
    if (first && cmd !== 'M' && cmd !== 'm') return finish('path data must start with a moveto')
    first = false

    const rel = cmd === cmd.toLowerCase()
    const lower = cmd.toLowerCase()
    const n = ARG_COUNT[lower]!
    const args: number[] = []
    for (let i = 0; i < n; i++) {
      const v = lower === 'a' && (i === 3 || i === 4) ? sc.flag() : sc.number()
      if (v === null) return finish(`missing or bad argument for "${cmd}"`)
      args.push(v)
    }
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    const a = (i: number) => args[i]!

    switch (lower) {
      case 'm': {
        x = ox + a(0)
        y = oy + a(1)
        current = null
        ensureSubpath()
        lastCubic = lastQuad = null
        break
      }
      case 'z': {
        const open = current as RawSubpath | null
        if (open) open.closed = true
        x = startX
        y = startY
        current = null
        lastCubic = lastQuad = null
        break
      }
      case 'l':
      case 'h':
      case 'v': {
        const sub = ensureSubpath()
        if (lower === 'l') {
          x = ox + a(0)
          y = oy + a(1)
        } else if (lower === 'h') x = (rel ? x : 0) + a(0)
        else y = (rel ? y : 0) + a(0)
        sub.segments.push({ kind: 'line', x, y })
        lastCubic = lastQuad = null
        break
      }
      case 'c':
      case 's': {
        const sub = ensureSubpath()
        let x1: number, y1: number, k: number
        if (lower === 'c') {
          x1 = ox + a(0)
          y1 = oy + a(1)
          k = 2
        } else {
          x1 = lastCubic ? 2 * x - lastCubic[0] : x
          y1 = lastCubic ? 2 * y - lastCubic[1] : y
          k = 0
        }
        const x2 = ox + a(k)
        const y2 = oy + a(k + 1)
        x = ox + a(k + 2)
        y = oy + a(k + 3)
        sub.segments.push({ kind: 'cubic', x1, y1, x2, y2, x, y })
        lastCubic = [x2, y2]
        lastQuad = null
        break
      }
      case 'q':
      case 't': {
        const sub = ensureSubpath()
        let qx: number, qy: number, k: number
        if (lower === 'q') {
          qx = ox + a(0)
          qy = oy + a(1)
          k = 2
        } else {
          qx = lastQuad ? 2 * x - lastQuad[0] : x
          qy = lastQuad ? 2 * y - lastQuad[1] : y
          k = 0
        }
        const ex = ox + a(k)
        const ey = oy + a(k + 1)
        sub.segments.push(quadToCubic(x, y, qx, qy, ex, ey))
        x = ex
        y = ey
        lastQuad = [qx, qy]
        lastCubic = null
        break
      }
      case 'a': {
        const sub = ensureSubpath()
        const ex = ox + a(5)
        const ey = oy + a(6)
        sub.segments.push(...arcSegments(x, y, a(0), a(1), a(2), a(3) === 1, a(4) === 1, ex, ey))
        x = ex
        y = ey
        lastCubic = lastQuad = null
        break
      }
    }
  }
  return finish(null)
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): Segment {
  return {
    kind: 'cubic',
    x1: x0 + (2 / 3) * (qx - x0),
    y1: y0 + (2 / 3) * (qy - y0),
    x2: x + (2 / 3) * (qx - x),
    y2: y + (2 / 3) * (qy - y),
    x,
    y,
  }
}

/** SVG endpoint arc → centre parameterisation (SVG 1.1 appendix F.6.5–F.6.6). */
export function arcSegments(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Segment[] {
  if (x1 === x2 && y1 === y2) return []
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return [{ kind: 'line', x: x2, y: y2 }]
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const t0 = angle(1, 0, ux, uy)
  let dt = angle(ux, uy, vx, vy)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  return [
    { kind: 'arc', cx, cy, ux: rx * cos, uy: rx * sin, vx: -ry * sin, vy: ry * cos, t0, dt },
    // The arc's computed end can differ from (x2, y2) by rounding; a zero-length line pins it exactly.
    { kind: 'line', x: x2, y: y2 },
  ]
}

// --- Basic shapes (SVG 1.1 §9) as segments in user units ---

export function rectSubpath(x: number, y: number, w: number, h: number, rxIn: number | null, ryIn: number | null): RawSubpath | null {
  if (!(w > 0) || !(h > 0)) return null
  let rx = rxIn ?? ryIn ?? 0
  let ry = ryIn ?? rxIn ?? 0
  rx = Math.min(Math.max(rx, 0), w / 2)
  ry = Math.min(Math.max(ry, 0), h / 2)
  if (rx === 0 || ry === 0) {
    return {
      x0: x,
      y0: y,
      closed: true,
      segments: [
        { kind: 'line', x: x + w, y },
        { kind: 'line', x: x + w, y: y + h },
        { kind: 'line', x, y: y + h },
      ],
    }
  }
  const corner = (cx: number, cy: number, t0: number): Segment => ({
    kind: 'arc',
    cx,
    cy,
    ux: rx,
    uy: 0,
    vx: 0,
    vy: ry,
    t0,
    dt: Math.PI / 2,
  })
  // Clockwise on screen (y down), starting after the top-left corner.
  return {
    x0: x + rx,
    y0: y,
    closed: true,
    segments: [
      { kind: 'line', x: x + w - rx, y },
      corner(x + w - rx, y + ry, -Math.PI / 2),
      { kind: 'line', x: x + w, y: y + h - ry },
      corner(x + w - rx, y + h - ry, 0),
      { kind: 'line', x: x + rx, y: y + h },
      corner(x + rx, y + h - ry, Math.PI / 2),
      { kind: 'line', x, y: y + ry },
      corner(x + rx, y + ry, Math.PI),
    ],
  }
}

export function ellipseSubpath(cx: number, cy: number, rx: number, ry: number): RawSubpath | null {
  if (!(rx > 0) || !(ry > 0)) return null
  return {
    x0: cx + rx,
    y0: cy,
    closed: true,
    segments: [{ kind: 'arc', cx, cy, ux: rx, uy: 0, vx: 0, vy: ry, t0: 0, dt: 2 * Math.PI }],
  }
}

export function polySubpath(points: number[], closed: boolean): RawSubpath | null {
  if (points.length < 4) return null
  const segments: Segment[] = []
  for (let i = 2; i + 1 < points.length; i += 2) segments.push({ kind: 'line', x: points[i]!, y: points[i + 1]! })
  return { x0: points[0]!, y0: points[1]!, segments, closed }
}

// --- Flattening ---

export interface Polyline {
  /** Interleaved x, y in output mm. A closed polyline does not repeat its first point. */
  points: Float64Array
  closed: boolean
}

const MAX_DEPTH = 18

/** Flattens one subpath through `m` into a polyline whose deviation from the curve is at most `tol`. */
export function flattenSubpath(sub: RawSubpath, m: Matrix, tol: number): Polyline | null {
  const out: number[] = []
  const push = (x: number, y: number) => {
    const n = out.length
    if (n >= 2 && Math.abs(out[n - 2]! - x) < 1e-9 && Math.abs(out[n - 1]! - y) < 1e-9) return
    out.push(x, y)
  }
  let [px, py] = apply(m, sub.x0, sub.y0)
  push(px, py)

  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, depth: number) => {
    if (depth >= MAX_DEPTH || cubicFlat(x0, y0, x1, y1, x2, y2, x3, y3, tol)) {
      push(x3, y3)
      return
    }
    const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2
    const bx = (x1 + x2) / 2, by = (y1 + y2) / 2
    const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2
    const dx = (ax + bx) / 2, dy = (ay + by) / 2
    const ex = (bx + cx) / 2, ey = (by + cy) / 2
    const fx = (dx + ex) / 2, fy = (dy + ey) / 2
    cubic(x0, y0, ax, ay, dx, dy, fx, fy, depth + 1)
    cubic(fx, fy, ex, ey, cx, cy, x3, y3, depth + 1)
  }

  for (const s of sub.segments) {
    if (s.kind === 'line') {
      ;[px, py] = apply(m, s.x, s.y)
      push(px, py)
    } else if (s.kind === 'cubic') {
      const [x1, y1] = apply(m, s.x1, s.y1)
      const [x2, y2] = apply(m, s.x2, s.y2)
      const [x3, y3] = apply(m, s.x, s.y)
      cubic(px, py, x1, y1, x2, y2, x3, y3, 0)
      px = x3
      py = y3
    } else {
      const [cx, cy] = apply(m, s.cx, s.cy)
      const [ux, uy] = applyLinear(m, s.ux, s.uy)
      const [vx, vy] = applyLinear(m, s.vx, s.vy)
      // Largest semi-axis of the transformed ellipse: the larger singular value of [u v].
      const t = ux * ux + uy * uy + vx * vx + vy * vy
      const det = ux * vy - uy * vx
      const r = Math.sqrt((t + Math.sqrt(Math.max(0, t * t - 4 * det * det))) / 2)
      const maxStep = r > tol ? 2 * Math.acos(1 - tol / r) : Math.PI / 2
      const n = Math.max(1, Math.ceil(Math.abs(s.dt) / Math.min(maxStep, Math.PI / 2)))
      for (let i = 1; i <= n; i++) {
        const a = s.t0 + (s.dt * i) / n
        px = cx + ux * Math.cos(a) + vx * Math.sin(a)
        py = cy + uy * Math.cos(a) + vy * Math.sin(a)
        push(px, py)
      }
    }
  }
  if (sub.closed && out.length >= 4) {
    const n = out.length
    if (Math.abs(out[0]! - out[n - 2]!) < 1e-9 && Math.abs(out[1]! - out[n - 1]!) < 1e-9) out.length = n - 2
  }
  if (out.length < 4) return null
  return { points: Float64Array.from(out), closed: sub.closed }
}

/** Control points within `tol` of the chord bound the curve's deviation from it (convex hull). */
function cubicFlat(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number): boolean {
  const dx = x3 - x0
  const dy = y3 - y0
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(x1 - x0, y1 - y0) <= tol && Math.hypot(x2 - x0, y2 - y0) <= tol
  const d1 = segmentDistance(x1, y1, x0, y0, dx, dy, len)
  const d2 = segmentDistance(x2, y2, x0, y0, dx, dy, len)
  return d1 <= tol && d2 <= tol
}

function segmentDistance(px: number, py: number, x0: number, y0: number, dx: number, dy: number, len: number): number {
  const t = ((px - x0) * dx + (py - y0) * dy) / (len * len)
  const c = Math.min(1, Math.max(0, t))
  return Math.hypot(px - (x0 + c * dx), py - (y0 + c * dy))
}

/** Length of a polyline in its own units, including the closing segment when closed. */
export function polylineLength(p: Polyline): number {
  const pts = p.points
  let len = 0
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!)
  if (p.closed && pts.length >= 4) len += Math.hypot(pts[0]! - pts[pts.length - 2]!, pts[1]! - pts[pts.length - 1]!)
  return len
}

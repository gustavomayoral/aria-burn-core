// SPDX-License-Identifier: MIT
// SVG import Fill mode geometry (BURN-52, feature BURN-49): scan lines over a
// layer's closed shapes, clipped by each shape's fill rule.
//
// The scan frame turns the bed by the scan angle: `a` runs along the scan
// direction (cos θ, sin θ) and `c` along its normal (-sin θ, cos θ). Lines sit
// every `intervalMm` in c, centred in the layer's extent along c, so a 10 mm
// shape at 0.1 mm gets 100 lines half an interval in from each edge.
//
// Each shape is filled by its own rule (evenodd or nonzero, as SVG renders
// it), and the layer is the union of its shapes. A crossing counts when the
// line is in [ymin, ymax) of an edge, so a line through a vertex crosses once.

/** A closed shape on the bed: its closed subpaths (interleaved x, y, first point not repeated) and fill rule. */
export interface FillShape {
  rings: Float64Array[]
  fillRule: 'nonzero' | 'evenodd'
  /** Index in SvgDocument.shapes, carried to the spans. */
  shape: number
}

/** A beam-on run on one scan line, from a0 to a1 (a0 < a1) along the scan direction. */
export interface ScanSpan {
  a0: number
  a1: number
  /** The shape the span starts in (the first, when the union joins several). */
  shape: number
}

export interface ScanLine {
  /** Position along the scan normal (mm). */
  c: number
  /** Disjoint spans in increasing a. */
  spans: ScanSpan[]
}

/** A point of the scan frame on the bed. */
export function scanToBed(a: number, c: number, angleDeg: number): [number, number] {
  const t = (angleDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return [a * cos - c * sin, a * sin + c * cos]
}

interface Edge {
  lo: number
  hi: number
  /** x at lo. */
  x: number
  slope: number
  dir: number
  shape: number
}

const MIN_SPAN_MM = 1e-6

/**
 * Scan lines of the union of `shapes` at `angleDeg`, every `intervalMm`, in
 * increasing c (bottom to top along the normal). Lines with no span are left out.
 */
export function scanLines(shapes: readonly FillShape[], angleDeg: number, intervalMm: number): ScanLine[] {
  if (!(intervalMm > 0)) throw new RangeError(`fill interval must be positive, got ${intervalMm}`)
  const t = (angleDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  const edges: Edge[] = []
  const rules: ('nonzero' | 'evenodd')[] = []
  let minC = Infinity
  let maxC = -Infinity
  shapes.forEach((sh, k) => {
    rules[k] = sh.fillRule
    for (const pts of sh.rings) {
      const n = pts.length / 2
      if (n < 3) continue
      const ra = new Float64Array(n)
      const rc = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const x = pts[2 * i]!
        const y = pts[2 * i + 1]!
        ra[i] = x * cos + y * sin
        rc[i] = -x * sin + y * cos
        minC = Math.min(minC, rc[i]!)
        maxC = Math.max(maxC, rc[i]!)
      }
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a0 = ra[j]!
        const c0 = rc[j]!
        const a1 = ra[i]!
        const c1 = rc[i]!
        if (c0 === c1) continue
        const slope = (a1 - a0) / (c1 - c0)
        if (c0 < c1) edges.push({ lo: c0, hi: c1, x: a0, slope, dir: 1, shape: k })
        else edges.push({ lo: c1, hi: c0, x: a1, slope, dir: -1, shape: k })
      }
    }
  })
  if (!edges.length) return []
  edges.sort((p, q) => p.lo - q.lo)

  const h = maxC - minC
  const n = Math.max(1, Math.round(h / intervalMm))
  const first = minC + (h - (n - 1) * intervalMm) / 2
  const lines: ScanLine[] = []
  let active: Edge[] = []
  let next = 0
  const xs: { x: number; dir: number; shape: number }[] = []
  for (let k = 0; k < n; k++) {
    const c = first + k * intervalMm
    while (next < edges.length && edges[next]!.lo <= c) active.push(edges[next++]!)
    active = active.filter((e) => e.hi > c)
    if (!active.length) continue
    xs.length = 0
    for (const e of active) if (e.lo <= c) xs.push({ x: e.x + (c - e.lo) * e.slope, dir: e.dir, shape: e.shape })
    xs.sort((p, q) => p.shape - q.shape || p.x - q.x)
    const raw: ScanSpan[] = []
    let i = 0
    while (i < xs.length) {
      const shape = xs[i]!.shape
      const evenodd = rules[shape] === 'evenodd'
      let w = 0
      let start = 0
      for (; i < xs.length && xs[i]!.shape === shape; i++) {
        const was = evenodd ? (w & 1) !== 0 : w !== 0
        w += evenodd ? 1 : xs[i]!.dir
        const is = evenodd ? (w & 1) !== 0 : w !== 0
        if (!was && is) start = xs[i]!.x
        else if (was && !is && xs[i]!.x - start > MIN_SPAN_MM) raw.push({ a0: start, a1: xs[i]!.x, shape: shapes[shape]!.shape })
      }
    }
    if (!raw.length) continue
    raw.sort((p, q) => p.a0 - q.a0)
    const spans: ScanSpan[] = [{ ...raw[0]! }]
    for (let r = 1; r < raw.length; r++) {
      const cur = spans[spans.length - 1]!
      const s = raw[r]!
      if (s.a0 <= cur.a1 + MIN_SPAN_MM) cur.a1 = Math.max(cur.a1, s.a1)
      else spans.push({ ...s })
    }
    lines.push({ c, spans })
  }
  return lines
}

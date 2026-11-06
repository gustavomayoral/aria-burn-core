// SPDX-License-Identifier: MIT
// Finding the reference card and the burned pattern in a photo (BURN-15).
//
// Card: the black frame is a large dark ring (dark against its surroundings,
// with a light hole). Its outer corners come from the ring's hull, refined by
// fitting a line to each outer edge. The four rotations are told apart later
// by the colour fit (photo.ts), since the patch colours are asymmetric.
//
// Pattern: the four corner fiducials are compact squares marked darker
// (char) or lighter (melt, bleach) than the bare material; the orientation
// square, a quarter of their area, sits beside the bottom-left one. The card's
// scale gives the expected fiducial size in pixels. Each candidate set of four
// is scored by how well a homography through it puts the orientation square
// where the pattern says it is.
//
// Detection runs on a downscaled luminance image; results are in full-size
// photo pixels. Either step can be replaced by corners the user places
// (the app lets them drag the corners when detection fails).

import { SRGB8_TO_LINEAR } from './color.ts'
import { applyH, fitHomography, type Homography, type Photo, type Point } from './image.ts'
import type { CalibrationPattern } from './types.ts'

export interface Gray {
  width: number
  height: number
  /** Linear luminance. */
  data: Float32Array
  /** Full-size photo px per gray px. */
  scale: number
}

/** Downscale to at most `maxSide` px by area averaging, as linear luminance. */
export function grayscale(photo: Photo, maxSide = 900): Gray {
  const s = Math.max(1, Math.ceil(Math.max(photo.width, photo.height) / maxSide))
  const w = Math.floor(photo.width / s)
  const h = Math.floor(photo.height / s)
  const data = new Float32Array(w * h)
  const d = photo.data
  const L = SRGB8_TO_LINEAR
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0
      for (let j = 0; j < s; j++)
        for (let i = 0; i < s; i++) {
          const o = ((y * s + j) * photo.width + x * s + i) * 4
          a += 0.2126 * L[d[o]!]! + 0.7152 * L[d[o + 1]!]! + 0.0722 * L[d[o + 2]!]!
        }
      data[y * w + x] = a / (s * s)
    }
  return { width: w, height: h, data, scale: s }
}

/** Box mean with radius r (integral image). */
export function boxMean(g: Gray, r: number): Float32Array {
  const { width: w, height: h, data } = g
  const I = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += data[y * w + x]!
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + row
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r)
    const y1 = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r)
      const x1 = Math.min(w, x + r + 1)
      const s = I[y1 * (w + 1) + x1]! - I[y0 * (w + 1) + x1]! - I[y1 * (w + 1) + x0]! + I[y0 * (w + 1) + x0]!
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0))
    }
  }
  return out
}

export interface Component {
  area: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  cx: number
  cy: number
  /** Leftmost and rightmost pixel per row (outer outline), y from minY. */
  rows: [number, number][]
}

/** 8-connected components of a mask (1 = set). */
export function components(mask: Uint8Array, w: number, h: number, minArea = 4): Component[] {
  const label = new Int32Array(w * h).fill(-1)
  const out: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] !== -1) continue
    const id = out.length
    let area = 0
    let sx = 0
    let sy = 0
    let minX = w
    let minY = h
    let maxX = 0
    let maxY = 0
    const pixels: number[] = []
    stack.push(start)
    label[start] = id
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w
      const y = (p - x) / w
      pixels.push(p)
      area++
      sx += x
      sy += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (mask[q] && label[q] === -1) {
            label[q] = id
            stack.push(q)
          }
        }
    }
    if (area < minArea) {
      out.push(null as unknown as Component)
      continue
    }
    const rows: [number, number][] = Array.from({ length: maxY - minY + 1 }, () => [w, -1])
    for (const p of pixels) {
      const x = p % w
      const r = rows[(p - x) / w - minY]!
      if (x < r[0]) r[0] = x
      if (x > r[1]) r[1] = x
    }
    out.push({ area, minX, minY, maxX, maxY, cx: sx / area, cy: sy / area, rows })
  }
  return out.filter(Boolean)
}

function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Point[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const polyArea = (p: Point[]) => {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const q = p[i]!
    const r = p[(i + 1) % p.length]!
    a += q.x * r.y - r.x * q.y
  }
  return Math.abs(a) / 2
}

/** Outline points of a component (row extremes, pixel edges). */
function outline(c: Component): Point[] {
  const pts: Point[] = []
  c.rows.forEach(([a, b], i) => {
    if (b < 0) return
    const y = c.minY + i
    pts.push({ x: a, y }, { x: a, y: y + 1 }, { x: b + 1, y }, { x: b + 1, y: y + 1 })
  })
  return pts
}

/** Four corners of a convex blob's hull, in image-clockwise order (y down). */
export function quadCorners(h: Point[]): Point[] {
  let best = [0, 0]
  let bd = -1
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++) {
      const d = (h[i]!.x - h[j]!.x) ** 2 + (h[i]!.y - h[j]!.y) ** 2
      if (d > bd) {
        bd = d
        best = [i, j]
      }
    }
  const A = h[best[0]!]!
  const C = h[best[1]!]!
  const side = (p: Point) => (C.x - A.x) * (p.y - A.y) - (C.y - A.y) * (p.x - A.x)
  let B = A
  let D = A
  let bmax = 0
  let dmin = 0
  for (const p of h) {
    const s = side(p)
    if (s > bmax) {
      bmax = s
      B = p
    }
    if (s < dmin) {
      dmin = s
      D = p
    }
  }
  // A, B, C, D: with y down, side > 0 is clockwise of A→C... order as a polygon.
  const quad = [A, B, C, D]
  return clockwise(quad)
}

/** Sort 4 points clockwise in image coordinates (y down), starting top-left-most. */
export function clockwise(p: Point[]): Point[] {
  const cx = p.reduce((s, q) => s + q.x, 0) / p.length
  const cy = p.reduce((s, q) => s + q.y, 0) / p.length
  const s = [...p].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
  let k = 0
  for (let i = 1; i < s.length; i++) if (s[i]!.x + s[i]!.y < s[k]!.x + s[k]!.y) k = i
  return [...s.slice(k), ...s.slice(0, k)]
}

/** Refine a quad's corners by fitting a line to the outline points along each side. */
function refineQuad(q: Point[], pts: Point[]): Point[] {
  const lines: { px: number; py: number; dx: number; dy: number }[] = []
  for (let i = 0; i < 4; i++) {
    const a = q[i]!
    const b = q[(i + 1) % 4]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const near = pts.filter((p) => {
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy
      const d = Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux)
      return t > 0.12 * len && t < 0.88 * len && d < Math.max(2, 0.03 * len)
    })
    if (near.length < 6) {
      lines.push({ px: a.x, py: a.y, dx: ux, dy: uy })
      continue
    }
    const mx = near.reduce((s, p) => s + p.x, 0) / near.length
    const my = near.reduce((s, p) => s + p.y, 0) / near.length
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (const p of near) {
      sxx += (p.x - mx) ** 2
      sxy += (p.x - mx) * (p.y - my)
      syy += (p.y - my) ** 2
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    lines.push({ px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) })
  }
  const out: Point[] = []
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4]!
    const l2 = lines[i]!
    const det = l1.dx * -l2.dy - l1.dy * -l2.dx
    if (Math.abs(det) < 1e-9) {
      out.push(q[i]!)
      continue
    }
    const t = ((l2.px - l1.px) * -l2.dy - (l2.py - l1.py) * -l2.dx) / det
    out.push({ x: l1.px + l1.dx * t, y: l1.py + l1.dy * t })
  }
  return out
}

export interface CardCandidate {
  /** Outer frame corners in photo px, image-clockwise from the top-left-most. Rotation not yet known. */
  corners: Point[]
  /** Ring area / hull area. */
  fill: number
  areaPx: number
}

/** Candidate card frames, largest first. */
export function findCardFrames(photo: Photo, gray: Gray = grayscale(photo)): CardCandidate[] {
  const { width: w, height: h, data } = gray
  const r = Math.max(4, Math.round(Math.max(w, h) / 40))
  const mean = boxMean(gray, r)
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) mask[i] = data[i]! < 0.45 * mean[i]! ? 1 : 0
  const comps = components(mask, w, h, Math.max(30, (w * h) / 5000))
  const out: CardCandidate[] = []
  for (const c of comps) {
    if (c.maxX - c.minX < w / 20 || c.maxY - c.minY < h / 20) continue
    const pts = outline(c)
    const hl = hull(pts)
    const ha = polyArea(hl)
    const fill = c.area / ha
    if (fill < 0.05 || fill > 0.5) continue
    const q = quadCorners(hl)
    const qa = polyArea(q)
    if (qa < 0.85 * ha) continue // not quad-like
    // The hole: the centre must be light.
    const cx = Math.round(q.reduce((s, p) => s + p.x, 0) / 4)
    const cy = Math.round(q.reduce((s, p) => s + p.y, 0) / 4)
    if (mask[cy * w + cx]) continue
    const refined = refineQuad(q, pts).map((p) => ({ x: p.x * gray.scale, y: p.y * gray.scale }))
    out.push({ corners: refined, fill, areaPx: qa * gray.scale * gray.scale })
  }
  return out.sort((a, b) => b.areaPx - a.areaPx)
}

export interface PatternDetection {
  /** Machine mm → photo px. */
  homography: Homography
  /** Fiducial and orientation centres found (photo px), by mark id. */
  marks: Record<string, Point>
  /** Orientation-square misfit (in fiducial sizes): 0 is perfect. */
  misfit: number
}

/**
 * Find the pattern's fiducials. `pxPerMm` is the expected scale near the
 * pattern (from the card); `marksLighter` is true when the material marks
 * lighter than it is (melt, bleach); `exclude` (photo px quad) masks the card.
 */
export function findPattern(
  photo: Photo,
  pattern: Pick<CalibrationPattern, 'marks'>,
  pxPerMm: number,
  marksLighter: boolean,
  exclude: Point[] | null,
  gray: Gray = grayscale(photo, 1400),
): PatternDetection | null {
  const fids = ['fid-bl', 'fid-br', 'fid-tr', 'fid-tl'].map((id) => pattern.marks.find((m) => m.id === id))
  const orient = pattern.marks.find((m) => m.id === 'orient')
  if (fids.some((m) => !m) || !orient) return null
  const fidMm = fids[0]!.rectMm.maxXMm - fids[0]!.rectMm.minXMm
  const { width: w, height: h, data } = gray
  const s = pxPerMm / gray.scale
  const fidPx = fidMm * s
  const r = Math.max(3, Math.round(fidPx * 2.5))
  const mean = boxMean(gray, r)
  const mask = new Uint8Array(w * h)
  const inside = exclude ? pointInQuad(exclude.map((p) => ({ x: p.x / gray.scale, y: p.y / gray.scale }))) : () => false
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = data[i]!
      const m = mean[i]!
      mask[i] = (marksLighter ? v > 1.6 * m : v < 0.62 * m) && !inside(x, y) ? 1 : 0
    }
  const comps = components(mask, w, h, Math.max(3, fidPx * fidPx * 0.05))
  const squareish = (c: Component) => {
    const bw = c.maxX - c.minX + 1
    const bh = c.maxY - c.minY + 1
    return bw / bh < 2 && bh / bw < 2 && c.area / (bw * bh) > 0.5
  }
  const A = fidPx * fidPx
  const fidC = comps.filter((c) => squareish(c) && c.area > 0.3 * A && c.area < 2.6 * A)
  const dotC = comps.filter((c) => squareish(c) && c.area > 0.06 * A && c.area < 0.6 * A)
  if (fidC.length < 4 || dotC.length < 1) return null
  const mmPts = fids.map((m) => ({ x: m!.centerMm.xMm, y: m!.centerMm.yMm }))
  const dotMm = { x: orient.centerMm.xMm, y: orient.centerMm.yMm }
  // All marked blobs (cells, labels, fiducials): the true four enclose every one of them.
  const blobs = comps.filter((c) => c.area > 0.15 * A).map((c) => ({ x: c.cx, y: c.cy }))
  let best: { misfit: number; pts: Point[]; dot: Point; inside: number; area: number } | null = null
  // Limit the search: biggest fiducial candidates first.
  const cand = fidC.sort((a, b) => b.area - a.area).slice(0, 16)
  for (const d of dotC) {
    const dot = { x: d.cx, y: d.cy }
    // BL: the fiducial candidate nearest the dot.
    // The dot itself is never a fiducial, and the fiducials are clearly bigger than it.
    const fidsHere = cand.filter((c) => c !== d && c.area > 2 * d.area)
    const near = fidsHere.filter((c) => Math.hypot(c.cx - dot.x, c.cy - dot.y) < 3 * fidPx).sort((a, b) => Math.hypot(a.cx - dot.x, a.cy - dot.y) - Math.hypot(b.cx - dot.x, b.cy - dot.y))
    if (!near.length) continue
    const bl = near[0]!
    const rest = fidsHere.filter((c) => c !== bl && c.area > 0.4 * bl.area && c.area < 2.5 * bl.area)
    for (let i = 0; i < rest.length; i++)
      for (let j = i + 1; j < rest.length; j++)
        for (let k = j + 1; k < rest.length; k++) {
          const four = [bl, rest[i]!, rest[j]!, rest[k]!].map((c) => ({ x: c.cx, y: c.cy }))
          // clockwise() runs TL → TR → BR → BL as seen; machine bl → br → tr → tl runs the other way.
          const cw = clockwise(four)
          const at = cw.findIndex((p) => p.x === bl.cx && p.y === bl.cy)
          const ordered = [0, 1, 2, 3].map((t) => cw[(at - t + 4) % 4]!)
          let H: Homography
          try {
            H = fitHomography(mmPts, ordered)
          } catch {
            continue
          }
          const pd = applyH(H, dotMm.x, dotMm.y)
          const misfit = Math.hypot(pd.x - dot.x, pd.y - dot.y) / fidPx
          if (misfit > 0.5) continue
          // Grow the quad by half a fiducial so blobs beside the fiducials count as inside.
          const cx = four.reduce((s, p) => s + p.x, 0) / 4
          const cy = four.reduce((s, p) => s + p.y, 0) / 4
          const grown = cw.map((p) => {
            const l = Math.hypot(p.x - cx, p.y - cy) || 1
            return { x: p.x + ((p.x - cx) / l) * fidPx, y: p.y + ((p.y - cy) / l) * fidPx }
          })
          const isIn = pointInQuad(grown)
          const inside = blobs.filter((b) => isIn(b.x, b.y)).length
          const area = Math.abs((cw[2]!.x - cw[0]!.x) * (cw[3]!.y - cw[1]!.y) - (cw[3]!.x - cw[1]!.x) * (cw[2]!.y - cw[0]!.y)) / 2
          // Most blobs enclosed; then the smallest such quad (a stray blob far away doesn't win); then the dot fit.
          if (!best || inside > best.inside || (inside === best.inside && (area < best.area * 0.98 || (area < best.area * 1.02 && misfit < best.misfit))))
            best = { misfit, pts: ordered, dot, inside, area }
        }
  }
  if (!best || best.misfit > 0.5) return null
  const full = (p: Point) => ({ x: (p.x + 0.5) * gray.scale, y: (p.y + 0.5) * gray.scale })
  const pts = best.pts.map(full)
  const dot = full(best.dot)
  const homography = fitHomography([...mmPts, dotMm], [...pts, dot])
  return {
    homography,
    marks: { 'fid-bl': pts[0]!, 'fid-br': pts[1]!, 'fid-tr': pts[2]!, 'fid-tl': pts[3]!, orient: dot },
    misfit: best.misfit,
  }
}

export function pointInQuad(q: Point[]): (x: number, y: number) => boolean {
  return (x, y) => {
    let sign = 0
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!
      const b = q[(i + 1) % q.length]!
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
      if (c === 0) continue
      const s = Math.sign(c)
      if (sign === 0) sign = s
      else if (s !== sign) return false
    }
    return true
  }
}

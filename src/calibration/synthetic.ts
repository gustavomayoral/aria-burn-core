// SPDX-License-Identifier: MIT
// Synthetic test-grid photos (BURN-15). No laser is available, so the photo
// fit is built and checked against photos made here: the simulator renders the
// burned pattern from known parameters, and the render is composited onto a
// board of bare material next to the reference card, then "photographed":
// perspective, rotation, uneven light, vignetting, white balance, exposure,
// lens blur, sensor noise and 8-bit sRGB encoding. The round-trip tests check
// that the fit recovers the known parameters from such a photo.
//
// The render uses the core's own CPU pipeline (deposit, blur, thermal step,
// response rules) at `finePitchMm` and averages it to photo pixels in linear
// light, as a camera does.

import { gridPitchMm, type BoundsMm, type Lab, type MachineProfile, type MaterialProfile } from '../contract/index.ts'
import { rampT, responseParams } from '../sim/response.ts'
import type { SampleStore } from '../sim/sample-store.ts'
import type { ThermalStep } from '../sim/thermal.ts'
import { cardFrameCorners, referenceCard, type CardSpec } from './card.ts'
import { encodeSrgb, labToLinear, type Rgb } from './color.ts'
import { blurredRect, fitKernel, SampleIndex, splitEnergies } from './forward.ts'
import { applyH, fitHomography, invertH, type Homography, type Photo, type Point } from './image.ts'

export interface PatternRender {
  /** Min corner of the render (absolute machine mm). */
  originXMm: number
  originYMm: number
  pitchMm: number
  width: number
  height: number
  /** Linear sRGB, 3 floats per pixel, row 0 = min Y. */
  rgb: Float32Array
}

export interface RenderOptions {
  /** Output pixel size (mm). Default 0.05. */
  outPitchMm?: number
  /** Simulation pitch (mm), rounded so it divides the output pitch. Default 2 × detail pitch. */
  finePitchMm?: number
  thermalStep?: ThermalStep
}

/** Simulate `material` over `bounds` and average it to `outPitchMm` pixels (linear light). */
export function renderPattern(
  store: SampleStore,
  machine: MachineProfile,
  material: MaterialProfile,
  bounds: BoundsMm,
  options: RenderOptions = {},
): PatternRender {
  const out = options.outPitchMm ?? 0.05
  const f = Math.max(1, Math.round(out / (options.finePitchMm ?? 2 * gridPitchMm(machine.spot))))
  const fine = out / f
  const { flash, bulk1, thermal } = splitEnergies(store, machine, material, options.thermalStep)
  const energies = thermal ? thermal.eDose : flash
  void bulk1
  const { separable, radiusMm } = fitKernel(machine, material, fine)
  const p = responseParams(material)
  const LUT = 1024
  const lut: Rgb[] = []
  for (let k = 0; k <= LUT; k++) {
    const t = k / LUT
    lut.push(labToLinear({ l: p.colorA.l + (p.colorB.l - p.colorA.l) * t, a: p.colorA.a + (p.colorB.a - p.colorA.a) * t, b: p.colorA.b + (p.colorB.b - p.colorA.b) * t }))
  }
  const polishedRgb = labToLinear(p.colorA)
  const x0 = Math.floor(bounds.minXMm / out)
  const y0 = Math.floor(bounds.minYMm / out)
  const width = Math.ceil(bounds.maxXMm / out) - x0
  const height = Math.ceil(bounds.maxYMm / out) - y0
  const rgb = new Float32Array(width * height * 3)
  const T = 96
  const index = new SampleIndex(store)
  for (let ty = 0; ty < height; ty += T) {
    for (let tx = 0; tx < width; tx += T) {
      const tw = Math.min(T, width - tx)
      const th = Math.min(T, height - ty)
      // One fine cell of extra border for the polished-edge neighbour rule.
      const rect: BoundsMm = {
        minXMm: (x0 + tx) * out - fine,
        minYMm: (y0 + ty) * out - fine,
        maxXMm: (x0 + tx + tw) * out + fine,
        maxYMm: (y0 + ty + th) * out + fine,
      }
      const field = blurredRect(index, energies, rect, fine, separable, radiusMm)
      const g = field.grid
      const at = (i: number, j: number) => (i < 0 || j < 0 || i >= g.width || j >= g.height ? 0 : field.data[j * g.width + i]!)
      // Offset of the tile's first fine cell inside the field.
      const ox = Math.round(((x0 + tx) * out - g.originXMm) / fine)
      const oy = Math.round(((y0 + ty) * out - g.originYMm) / fine)
      for (let j = 0; j < th * f; j++) {
        for (let i = 0; i < tw * f; i++) {
          const fi = ox + i
          const fj = oy + j
          const d = at(fi, fj)
          let c: Rgb
          if (p.polishedEdge && d < p.depthThreshold && d >= p.edgeMinFluence && Math.max(at(fi - 1, fj), at(fi + 1, fj), at(fi, fj - 1), at(fi, fj + 1)) >= p.depthThreshold)
            c = polishedRgb
          else {
            const t = rampT(p, d) * LUT
            const k = Math.min(LUT - 1, Math.floor(t))
            const a = t - k
            const c0 = lut[k]!
            const c1 = lut[k + 1]!
            c = [c0[0] + (c1[0] - c0[0]) * a, c0[1] + (c1[1] - c0[1]) * a, c0[2] + (c1[2] - c0[2]) * a]
          }
          const o = ((ty + Math.floor(j / f)) * width + tx + Math.floor(i / f)) * 3
          rgb[o]! += c[0]
          rgb[o + 1]! += c[1]
          rgb[o + 2]! += c[2]
        }
      }
    }
  }
  const inv = 1 / (f * f)
  for (let i = 0; i < rgb.length; i++) rgb[i]! *= inv
  return { originXMm: x0 * out, originYMm: y0 * out, pitchMm: out, width, height, rgb }
}

/** Deterministic PRNG (mulberry32) and a Gaussian from it. */
export function rng(seed: number): { next: () => number; gauss: () => number } {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = () => {
    const u = Math.max(next(), 1e-12)
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
  }
  return { next, gauss }
}

export interface PhotoConditions {
  seed?: number
  widthPx?: number
  heightPx?: number
  /** In-plane rotation of the whole view (degrees). */
  rotationDeg?: number
  /** Perspective: each photo corner moves by up to this fraction of the image size. */
  perspective?: number
  /** Card placement beside the pattern, and its own rotation on the board (degrees). */
  cardSide?: 'right' | 'left' | 'below' | 'above'
  cardAngleDeg?: number
  /** Per-channel camera gains (white balance) and overall exposure. */
  whiteBalance?: Rgb
  exposure?: number
  /** Linear light gradient across the view: ±strength at the edges, direction in degrees. */
  gradient?: { strength: number; angleDeg: number }
  /** Radial falloff at the image corners (fraction). */
  vignette?: number
  /** Gaussian lens blur (photo px). */
  blurPx?: number
  /** Sensor noise: read (linear units) and shot (× √signal). */
  noise?: { read: number; shot: number }
  /** Bare-material texture amplitude (fraction, low-frequency grain). */
  texture?: number
  /** Random print error of the card patches (ΔE76 per patch), to model an inexact print. */
  cardPrintErrorDE?: number
}

export interface SyntheticPhoto {
  photo: Photo
  /** Ground truth: machine mm → photo px, and card mm → photo px. */
  patternH: Homography
  cardH: Homography
  /** The card colours as printed in this synthetic world. */
  printedCard: CardSpec
}

const PAPER: Lab = { l: 95, a: 0, b: -1.5 }
const INK_BLACK: Lab = { l: 14, a: 0, b: 0 }
const TABLE: Lab = { l: 30, a: 1, b: -3 }

/**
 * Composite `render` (pattern, machine mm) and the reference card onto bare
 * `baseColor` material and photograph it under `conditions`.
 */
export function syntheticPhoto(render: PatternRender, baseColor: Lab, conditions: PhotoConditions = {}): SyntheticPhoto {
  const c = conditions
  const R = rng(c.seed ?? 1)
  const W = c.widthPx ?? 2400
  const H = c.heightPx ?? 1800
  // Card with optional print error.
  const card = referenceCard()
  const pe = c.cardPrintErrorDE ?? 0
  if (pe > 0) for (const p of card.patches) p.lab = { l: p.lab.l + R.gauss() * pe * 0.6, a: p.lab.a + R.gauss() * pe * 0.55, b: p.lab.b + R.gauss() * pe * 0.55 }
  // Board layout in machine mm (y up). Card placed beside the pattern.
  const pb = { minX: render.originXMm, minY: render.originYMm, maxX: render.originXMm + render.width * render.pitchMm, maxY: render.originYMm + render.height * render.pitchMm }
  const gap = 12
  const side = c.cardSide ?? 'right'
  const cardW = card.widthMm
  const cardH = card.heightMm
  const pcx = (pb.minX + pb.maxX) / 2
  const pcy = (pb.minY + pb.maxY) / 2
  const cc =
    side === 'right'
      ? { x: pb.maxX + gap + cardW / 2, y: pcy }
      : side === 'left'
        ? { x: pb.minX - gap - cardW / 2, y: pcy }
        : side === 'below'
          ? { x: pcx, y: pb.minY - gap - cardH / 2 }
          : { x: pcx, y: pb.maxY + gap + cardH / 2 }
  const ca = ((c.cardAngleDeg ?? 0) * Math.PI) / 180
  // card mm (u right, v down) → board mm (x right, y up)
  const cardToBoard = (u: number, v: number): Point => {
    const du = u - cardW / 2
    const dv = -(v - cardH / 2)
    return { x: cc.x + du * Math.cos(ca) - dv * Math.sin(ca), y: cc.y + du * Math.sin(ca) + dv * Math.cos(ca) }
  }
  const cardCorners = [cardToBoard(0, 0), cardToBoard(cardW, 0), cardToBoard(cardW, cardH), cardToBoard(0, cardH)]
  const xs = [pb.minX, pb.maxX, ...cardCorners.map((p) => p.x)]
  const ys = [pb.minY, pb.maxY, ...cardCorners.map((p) => p.y)]
  const margin = 15
  const view = { minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin, minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin }
  // Board → photo: view rect corners (TL, TR, BR, BL as seen, y up → down) to a rotated, jittered quad.
  const vw = view.maxX - view.minX
  const vh = view.maxY - view.minY
  const rot = ((c.rotationDeg ?? 0) * Math.PI) / 180
  const cosr = Math.abs(Math.cos(rot))
  const sinr = Math.abs(Math.sin(rot))
  const scale = 0.86 * Math.min(W / (vw * cosr + vh * sinr), H / (vw * sinr + vh * cosr))
  const persp = c.perspective ?? 0
  const corner = (x: number, y: number): Point => {
    const dx = (x - (view.minX + vw / 2)) * scale
    const dy = -(y - (view.minY + vh / 2)) * scale
    return {
      x: W / 2 + dx * Math.cos(rot) - dy * Math.sin(rot) + (R.next() * 2 - 1) * persp * W,
      y: H / 2 + dx * Math.sin(rot) + dy * Math.cos(rot) + (R.next() * 2 - 1) * persp * H,
    }
  }
  const boardPts = [
    { x: view.minX, y: view.maxY },
    { x: view.maxX, y: view.maxY },
    { x: view.maxX, y: view.minY },
    { x: view.minX, y: view.minY },
  ]
  const photoPts = boardPts.map((p) => corner(p.x, p.y))
  const boardToPhoto = fitHomography(boardPts, photoPts)
  const photoToBoard = invertH(boardToPhoto)
  // Card mm → photo truth.
  const cardFrame = cardFrameCorners(card)
  const cardHTruth = fitHomography(cardFrame, cardFrame.map((p) => applyH(boardToPhoto, ...xy(cardToBoard(p.x, p.y)))))
  // Colours.
  const baseLin = labToLinear(baseColor)
  const paperLin = labToLinear(PAPER)
  const inkLin = labToLinear(INK_BLACK)
  const tableLin = labToLinear(TABLE)
  const patchLin = card.patches.map((p) => labToLinear(p.lab))
  const tex = c.texture ?? 0.015
  const phases = Array.from({ length: 6 }, () => [R.next() * 6.283, 0.05 + R.next() * 0.3, R.next() * 6.283] as const)
  const texture = (x: number, y: number) => {
    let s = 0
    for (const [ph, fr, ang] of phases) s += Math.sin(ph + fr * (x * Math.cos(ang) + y * Math.sin(ang)))
    return 1 + (tex * s) / 3
  }
  const boardExtra = 30
  const sceneAt = (bx: number, by: number, out: number[]) => {
    // Card on top
    const du = bx - cc.x
    const dv = by - cc.y
    const u = du * Math.cos(ca) + dv * Math.sin(ca) + cardW / 2
    const v = -(-du * Math.sin(ca) + dv * Math.cos(ca)) + cardH / 2
    if (u >= 0 && v >= 0 && u <= cardW && v <= cardH) {
      const fo = card.frameOuter
      const fi = card.frameInner
      let col = paperLin
      if (u >= fo.x0 && u <= fo.x1 && v >= fo.y0 && v <= fo.y1 && !(u > fi.x0 && u < fi.x1 && v > fi.y0 && v < fi.y1)) col = inkLin
      else
        for (let i = 0; i < card.patches.length; i++) {
          const p = card.patches[i]!
          if (u >= p.xMm && u <= p.xMm + p.sizeMm && v >= p.yMm && v <= p.yMm + p.sizeMm) {
            col = patchLin[i]!
            break
          }
        }
      out[0] = col[0]
      out[1] = col[1]
      out[2] = col[2]
      return
    }
    if (bx < view.minX - boardExtra || bx > view.maxX + boardExtra || by < view.minY - boardExtra || by > view.maxY + boardExtra) {
      out[0] = tableLin[0]
      out[1] = tableLin[1]
      out[2] = tableLin[2]
      return
    }
    const t = texture(bx, by)
    const rx = (bx - render.originXMm) / render.pitchMm - 0.5
    const ry = (by - render.originYMm) / render.pitchMm - 0.5
    if (rx >= 0 && ry >= 0 && rx < render.width - 1 && ry < render.height - 1) {
      const ix = Math.floor(rx)
      const iy = Math.floor(ry)
      const ax = rx - ix
      const ay = ry - iy
      for (let k = 0; k < 3; k++) {
        const g = (i: number, j: number) => render.rgb[(j * render.width + i) * 3 + k]!
        out[k] = t * ((g(ix, iy) * (1 - ax) + g(ix + 1, iy) * ax) * (1 - ay) + (g(ix, iy + 1) * (1 - ax) + g(ix + 1, iy + 1) * ax) * ay)
      }
      return
    }
    out[0] = baseLin[0] * t
    out[1] = baseLin[1] * t
    out[2] = baseLin[2] * t
  }
  const wb = c.whiteBalance ?? [1, 1, 1]
  const exposure = c.exposure ?? 1
  const grad = c.gradient ?? { strength: 0, angleDeg: 0 }
  const ga = (grad.angleDeg * Math.PI) / 180
  const vx = view.minX + vw / 2
  const vy = view.minY + vh / 2
  const halfDiag = Math.hypot(vw, vh) / 2
  const vig = c.vignette ?? 0
  const img = new Float32Array(W * H * 3)
  const s = [0, 0, 0]
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const q = applyH(photoToBoard, px + 0.25 + 0.5 * sx, py + 0.25 + 0.5 * sy)
          sceneAt(q.x, q.y, s)
          const light = 1 + (grad.strength * ((q.x - vx) * Math.cos(ga) + (q.y - vy) * Math.sin(ga))) / halfDiag
          r += s[0]! * light
          g += s[1]! * light
          b += s[2]! * light
        }
      const rr = ((px + 0.5 - W / 2) ** 2 + (py + 0.5 - H / 2) ** 2) / ((W / 2) ** 2 + (H / 2) ** 2)
      const k = (exposure * (1 - vig * rr)) / 4
      const o = (py * W + px) * 3
      img[o] = r * k * wb[0]
      img[o + 1] = g * k * wb[1]
      img[o + 2] = b * k * wb[2]
    }
  }
  const blurred = (c.blurPx ?? 0) > 0 ? gaussianBlur3(img, W, H, c.blurPx!) : img
  const noise = c.noise ?? { read: 0, shot: 0 }
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < 3; k++) {
      const v = blurred[i * 3 + k]!
      const n = noise.read || noise.shot ? R.gauss() * (noise.read + noise.shot * Math.sqrt(Math.max(v, 0))) : 0
      data[i * 4 + k] = Math.round(encodeSrgb(v + n) * 255)
    }
    data[i * 4 + 3] = 255
  }
  return { photo: { width: W, height: H, data }, patternH: boardToPhoto, cardH: cardHTruth, printedCard: card }
}

const xy = (p: Point): [number, number] => [p.x, p.y]

function gaussianBlur3(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3)
  const k: number[] = []
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k.push(v)
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i]! /= sum
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0
        for (let t = -r; t <= r; t++) {
          const xx = Math.min(w - 1, Math.max(0, x + t))
          a += src[(y * w + xx) * 3 + c]! * k[t + r]!
        }
        tmp[(y * w + x) * 3 + c] = a
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let a = 0
        for (let t = -r; t <= r; t++) {
          const yy = Math.min(h - 1, Math.max(0, y + t))
          a += tmp[(yy * w + x) * 3 + c]! * k[t + r]!
        }
        out[(y * w + x) * 3 + c] = a
      }
  return out
}

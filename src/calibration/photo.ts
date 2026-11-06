// SPDX-License-Identifier: MIT
// From a photo of a burned pattern and the reference card to per-cell colours
// (BURN-15): find both, correct lighting and colour, sample each cell in Lab.
//
//   1. Card: frame candidates from detect.ts; for each of the 4 rotations,
//      sample the patches and fit the colour correction; keep the rotation
//      that fits best.
//   2. Flat field: log luminance = level + plane(x, y), with one level for
//      the card's bare-paper ring and one for the bare material around the
//      pattern (both uniform, reflectance unknown). The plane is the lighting
//      gradient; dividing it out makes the card and the grid see the same light.
//   3. Colour: affine map (3 × 4, least squares over the 24 patches) from
//      flat-fielded camera linear RGB to the patches' reference linear sRGB.
//      It absorbs white balance, exposure and the camera's colour matrix as far
//      as an affine map can; the camera's encoding is assumed to be sRGB.
//   4. Cells: the inner region of each cell (the forward model's inset)
//      sampled on a grid through the pattern homography, a luminance-trimmed
//      mean in linear light, then corrected and converted to Lab once.
//
// Bidirectional fills and the scan offset (BURN-48): the forward model shifts
// reverse lines exactly as the machine profile says, and the sampled inset
// (20 % of the cell, 1.2 mm on a 6 mm cell) keeps the shifted line ends out
// of the sampled region for offsets up to that size. A machine whose real
// offset isn't in its profile shows it as a darker or lighter cell edge,
// outside the sample; it moves the fiducial centres by half the offset, which
// the inset also absorbs.

import type { Lab } from '../contract/index.ts'
import { cardFrameCorners, referenceCard, type CardSpec } from './card.ts'
import { deltaE2000, labToLinear, linearToLab, luminance, SRGB8_TO_LINEAR, type Rgb } from './color.ts'
import { findCardFrames, findPattern, grayscale, pointInQuad } from './detect.ts'
import type { CellObservation } from './fit.ts'
import { DEFAULT_INSET_FRACTION, innerRect } from './forward.ts'
import { applyH, decodePhoto, fitHomography, solveLinear, type Homography, type Photo, type Point } from './image.ts'
import type { CalibrationPattern } from './types.ts'

export interface FlatField {
  /** Gain = exp(gx · u + gy · v), u, v = (px − centre) / max side. */
  gx: number
  gy: number
  cx: number
  cy: number
  norm: number
  /** Samples used (paper ring, bare material). */
  paperSamples: number
  materialSamples: number
}

export interface ColourCorrection {
  /** 3 × 4 row-major: reference linear = M · [r, g, b, 1]. */
  matrix: Float64Array
  flat: FlatField
  /** Patch ΔE00 after correction (how well the card fits). */
  patchDeltaE: { id: string; deltaE: number }[]
  meanPatchDeltaE: number
}

export interface PhotoAnalysis {
  /** Card mm → photo px. */
  cardH: Homography
  /** Card frame corners in card order (TL, TR, BR, BL of the card), photo px. */
  cardCorners: Point[]
  /** Machine mm → photo px. */
  patternH: Homography
  marks: Record<string, Point>
  correction: ColourCorrection
  observations: CellObservation[]
  base: Lab
  /** Each cell's sampled quad (photo px), for overlays. */
  cellQuads: { id: string; quad: Point[] }[]
  warnings: string[]
}

export interface AnalyseOptions {
  card?: CardSpec
  /** Card frame outer corners placed by hand, in card order (TL, TR, BR, BL), photo px. */
  cardCorners?: Point[]
  /** Fiducial centres placed by hand (photo px), in mark order fid-bl, fid-br, fid-tr, fid-tl. */
  fiducials?: Point[]
  insetFraction?: number
  /** Marks lighter than the bare material (melt, bleach) or darker (char). */
  marksLighter: boolean
  /** Bare-material ring around the burn (mm from the burn bounds). Default 9. */
  materialRingMm?: number
}

interface Sampler {
  lin: Float32Array
  photo: Photo
}

/** Mean linear RGB over a set of points (luminance-trimmed `trim` each side), with positions for the flat field. */
/** Linear value at or above which a channel counts as clipped (sRGB8 253 and up). */
export const CLIPPED = 0.985

function meanAt(s: Sampler, pts: Point[], trim = 0.1, gain?: (p: Point) => number): Rgb | null {
  const vals: { y: number; c: Rgb }[] = []
  const { photo, lin } = s
  let clipped = 0
  for (const p of pts) {
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    if (x < 1 || y < 1 || x >= photo.width - 1 || y >= photo.height - 1) continue
    const o = (y * photo.width + x) * 3
    // A clipped channel no longer says how bright the surface is.
    if (lin[o]! >= CLIPPED || lin[o + 1]! >= CLIPPED || lin[o + 2]! >= CLIPPED) {
      clipped++
      continue
    }
    const g = gain ? gain(p) : 1
    const c: Rgb = [lin[o]! / g, lin[o + 1]! / g, lin[o + 2]! / g]
    vals.push({ y: luminance(c), c })
  }
  if (vals.length < 4 || clipped > 0.3 * (vals.length + clipped)) return null
  vals.sort((a, b) => a.y - b.y)
  const k = Math.floor(vals.length * trim)
  const use = vals.slice(k, vals.length - k)
  const m: Rgb = [0, 0, 0]
  for (const v of use) for (let i = 0; i < 3; i++) m[i]! += v.c[i]!
  return m.map((v) => v / use.length) as Rgb
}

/** Grid of points over an axis-aligned rect in some plane, mapped through H. */
function rectPoints(H: Homography, x0: number, y0: number, x1: number, y1: number, n: number): Point[] {
  const pts: Point[] = []
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) pts.push(applyH(H, x0 + ((i + 0.5) * (x1 - x0)) / n, y0 + ((j + 0.5) * (y1 - y0)) / n))
  return pts
}

function fitAffine(obs: Rgb[], ref: Rgb[]): Float64Array {
  const M = new Float64Array(12)
  for (let c = 0; c < 3; c++) {
    const A = new Float64Array(16)
    const b = new Float64Array(4)
    for (let i = 0; i < obs.length; i++) {
      const x = [obs[i]![0], obs[i]![1], obs[i]![2], 1]
      for (let a = 0; a < 4; a++) {
        b[a]! += x[a]! * ref[i]![c]!
        for (let d = 0; d < 4; d++) A[a * 4 + d]! += x[a]! * x[d]!
      }
    }
    for (let a = 0; a < 4; a++) A[a * 4 + a]! += 1e-9
    const sol = solveLinear(A, b, 4) ?? new Float64Array([c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0, 0])
    for (let a = 0; a < 4; a++) M[c * 4 + a] = sol[a]!
  }
  return M
}

export const applyAffine = (M: Float64Array, c: Rgb): Rgb => [0, 1, 2].map((k) => M[k * 4]! * c[0] + M[k * 4 + 1]! * c[1] + M[k * 4 + 2]! * c[2] + M[k * 4 + 3]!) as Rgb

function patchMeans(s: Sampler, card: CardSpec, H: Homography, gain?: (p: Point) => number): (Rgb | null)[] {
  return card.patches.map((p) => {
    const m = p.sizeMm * 0.25
    return meanAt(s, rectPoints(H, p.xMm + m, p.yMm + m, p.xMm + p.sizeMm - m, p.yMm + p.sizeMm - m, 10), 0.1, gain)
  })
}

function correctionFrom(card: CardSpec, means: (Rgb | null)[]): { M: Float64Array; patchDeltaE: { id: string; deltaE: number }[]; mean: number } | null {
  const obs: Rgb[] = []
  const ref: Rgb[] = []
  const ids: string[] = []
  means.forEach((m, i) => {
    if (!m) return
    obs.push(m)
    ref.push(labToLinear(card.patches[i]!.lab))
    ids.push(card.patches[i]!.id)
  })
  if (obs.length < 12) return null
  const M = fitAffine(obs, ref)
  const patchDeltaE = obs.map((o, i) => ({ id: ids[i]!, deltaE: deltaE2000(linearToLab(applyAffine(M, o).map((v) => Math.max(v, 0)) as Rgb), card.patches.find((p) => p.id === ids[i])!.lab) }))
  return { M, patchDeltaE, mean: patchDeltaE.reduce((s, p) => s + p.deltaE, 0) / patchDeltaE.length }
}

/** Points along the card's bare-paper ring (between frame and patches). */
function paperRing(card: CardSpec): Point[] {
  const i = card.frameInner
  const x0 = i.x0 + 1.8
  const y0 = i.y0 + 1.8
  const x1 = i.x1 - 1.8
  const y1 = i.y1 - 1.8
  const pts: Point[] = []
  for (let x = x0; x <= x1; x += 2.5) pts.push({ x, y: y0 }, { x, y: y1 })
  for (let y = y0 + 2.5; y < y1; y += 2.5) pts.push({ x: x0, y }, { x: x1, y })
  return pts
}

/** Points on a rectangular ring `d` mm outside `b` (machine mm). */
function materialRing(b: { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number }, d: number): Point[] {
  const pts: Point[] = []
  const x0 = b.minXMm - d
  const y0 = b.minYMm - d
  const x1 = b.maxXMm + d
  const y1 = b.maxYMm + d
  for (let x = x0; x <= x1; x += 3) pts.push({ x, y: y0 }, { x, y: y1 })
  for (let y = y0 + 3; y < y1; y += 3) pts.push({ x: x0, y }, { x: x1, y })
  return pts
}

/** A small disc of points (radius in the plane's units) mapped through H. */
const disc = (H: Homography, c: Point, r: number): Point[] => rectPoints(H, c.x - r, c.y - r, c.x + r, c.y + r, 4)

function fitFlatField(s: Sampler, paper: Point[][], material: Point[][]): FlatField {
  const W = s.photo.width
  const H = s.photo.height
  const norm = Math.max(W, H)
  const cx = W / 2
  const cy = H / 2
  type Row = { u: number; v: number; y: number; kind: 0 | 1 }
  let rows: Row[] = []
  for (const [kind, set] of [[0, paper], [1, material]] as const)
    for (const pts of set) {
      const m = meanAt(s, pts, 0.2)
      if (!m) continue
      const c = pts[Math.floor(pts.length / 2)]!
      const y = luminance(m)
      if (y > 0) rows.push({ u: (c.x - cx) / norm, v: (c.y - cy) / norm, y: Math.log(y), kind })
    }
  const solve = (rs: Row[]) => {
    // Unknowns: a0 (paper), a1 (material), gx, gy.
    const A = new Float64Array(16)
    const b = new Float64Array(4)
    for (const r of rs) {
      const x = [r.kind === 0 ? 1 : 0, r.kind === 1 ? 1 : 0, r.u, r.v]
      for (let i = 0; i < 4; i++) {
        b[i]! += x[i]! * r.y
        for (let j = 0; j < 4; j++) A[i * 4 + j]! += x[i]! * x[j]!
      }
    }
    for (let i = 0; i < 4; i++) A[i * 4 + i]! += 1e-6
    return solveLinear(A, b, 4)
  }
  const paperN = rows.filter((r) => r.kind === 0).length
  const matN = rows.filter((r) => r.kind === 1).length
  // Either group alone still gives the plane (a group with no samples keeps level 0 through the ridge).
  if (paperN < 6) rows = rows.filter((r) => r.kind === 1)
  if (matN < 6) rows = rows.filter((r) => r.kind === 0)
  let sol = rows.length >= 6 ? solve(rows) : null
  if (sol) {
    // One robust pass: drop points more than 3 MADs off the plane (dust, labels, shadows).
    const res = rows.map((r) => r.y - ((r.kind === 0 ? sol![0]! : sol![1]!) + sol![2]! * r.u + sol![3]! * r.v))
    const med = [...res].map(Math.abs).sort((a, b) => a - b)[Math.floor(res.length / 2)]! || 1e-6
    rows = rows.filter((_, i) => Math.abs(res[i]!) < 3 * 1.4826 * med + 1e-4)
    sol = solve(rows) ?? sol
  }
  return {
    gx: sol ? sol[2]! : 0,
    gy: sol ? sol[3]! : 0,
    cx,
    cy,
    norm,
    paperSamples: paperN,
    materialSamples: matN,
  }
}

export const flatGain = (f: FlatField) => (p: Point) => Math.exp(f.gx * ((p.x - f.cx) / f.norm) + f.gy * ((p.y - f.cy) / f.norm))

/** Card mm → photo px for the frame corners in each of the 4 rotations; best colour fit wins. */
function orientCard(s: Sampler, card: CardSpec, corners: Point[]): { H: Homography; corners: Point[]; score: number } | null {
  const frame = cardFrameCorners(card)
  let best: { H: Homography; corners: Point[]; score: number } | null = null
  for (let r = 0; r < 4; r++) {
    const c = [0, 1, 2, 3].map((k) => corners[(k + r) % 4]!)
    const H = fitHomography(frame, c)
    const corr = correctionFrom(card, patchMeans(s, card, H))
    if (corr && (!best || corr.mean < best.score)) best = { H, corners: c, score: corr.mean }
  }
  return best
}

/** Photo px per machine mm near a point, from a homography. */
function scaleAt(H: Homography, x: number, y: number): number {
  const a = applyH(H, x, y)
  const b = applyH(H, x + 1, y)
  const c = applyH(H, x, y + 1)
  return Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y))
}

export class PhotoAnalysisError extends Error {
  constructor(
    message: string,
    readonly stage: 'card' | 'pattern' | 'colour',
  ) {
    super(message)
    this.name = 'PhotoAnalysisError'
  }
}

/** The whole photo step: card, pattern, flat field, colour correction and per-cell Lab. */
export function analysePhoto(photo: Photo, pattern: Pick<CalibrationPattern, 'cells' | 'marks' | 'burnBoundsMm'>, options: AnalyseOptions): PhotoAnalysis {
  const card = options.card ?? referenceCard()
  const warnings: string[] = []
  const s: Sampler = { photo, lin: decodePhoto(photo, SRGB8_TO_LINEAR) }
  // 1. Card
  let cardFit: { H: Homography; corners: Point[]; score: number } | null = null
  if (options.cardCorners) {
    const H = fitHomography(cardFrameCorners(card), options.cardCorners)
    cardFit = { H, corners: options.cardCorners, score: NaN }
  } else {
    for (const cand of findCardFrames(photo).slice(0, 4)) {
      const o = orientCard(s, card, cand.corners)
      if (o && (!cardFit || o.score < cardFit.score)) cardFit = o
    }
    if (!cardFit || cardFit.score > 12) throw new PhotoAnalysisError('Reference card not found. Place its four frame corners by hand.', 'card')
  }
  const cardQuad = [applyH(cardFit.H, 0, 0), applyH(cardFit.H, card.widthMm, 0), applyH(cardFit.H, card.widthMm, card.heightMm), applyH(cardFit.H, 0, card.heightMm)]
  // 2. Pattern
  const fidIds = ['fid-bl', 'fid-br', 'fid-tr', 'fid-tl']
  let patternH: Homography
  let marks: Record<string, Point>
  if (options.fiducials) {
    const mm = fidIds.map((id) => pattern.marks.find((m) => m.id === id)!.centerMm).map((c) => ({ x: c.xMm, y: c.yMm }))
    patternH = fitHomography(mm, options.fiducials)
    marks = Object.fromEntries(fidIds.map((id, i) => [id, options.fiducials![i]!]))
  } else {
    // Card scale: card mm → px near its centre.
    const pxPerMm = scaleAt(cardFit.H, card.widthMm / 2, card.heightMm / 2)
    const det = findPattern(photo, pattern, pxPerMm, options.marksLighter, cardQuad)
    if (!det) throw new PhotoAnalysisError('Pattern fiducials not found. Place the four corner squares by hand.', 'pattern')
    patternH = det.homography
    marks = det.marks
  }
  const outsideCard = (p: Point) => !pointInQuad(cardQuad)(p.x, p.y)
  const inPhoto = (p: Point) => p.x > 2 && p.y > 2 && p.x < photo.width - 2 && p.y < photo.height - 2
  // 3. Flat field: paper ring on the card, bare material around the pattern.
  const pxPerCardMm = scaleAt(cardFit.H, card.widthMm / 2, card.heightMm / 2)
  const paper = paperRing(card).map((c) => disc(cardFit!.H, c, 0.8))
  const ringMm = options.materialRingMm ?? 9
  const material = materialRing(pattern.burnBoundsMm, ringMm)
    .map((c) => disc(patternH, c, 1.2))
    .filter((pts) => pts.every((p) => inPhoto(p) && outsideCard(p)))
  void pxPerCardMm
  const flat = fitFlatField(s, paper, material)
  if (flat.materialSamples < 6) warnings.push('Too little bare material around the grid to estimate uneven lighting; assumed even.')
  const gain = flatGain(flat)
  // 4. Colour correction
  const means = patchMeans(s, card, cardFit.H, gain)
  const unread = means.filter((m) => !m).length
  if (unread) warnings.push(`${unread} card patch(es) clipped or unreadable and left out: the photo may be overexposed.`)
  if (flat.paperSamples < 6) warnings.push('The card’s white border is clipped: lighting estimated from the bare material only.')
  const corr = correctionFrom(card, means)
  if (!corr) throw new PhotoAnalysisError('Too few card patches readable (overexposed?).', 'colour')
  if (corr.mean > 3) warnings.push(`The card fits poorly after correction (mean ΔE00 ${corr.mean.toFixed(1)}): check the light (glare, coloured light) or the print.`)
  const toLab = (m: Rgb) => linearToLab(applyAffine(corr.M, m).map((v) => Math.max(v, 1e-6)) as Rgb)
  // 5. Cells and base
  const inset = options.insetFraction ?? DEFAULT_INSET_FRACTION
  const observations: CellObservation[] = []
  const cellQuads: { id: string; quad: Point[] }[] = []
  for (const cell of pattern.cells) {
    const r = innerRect(cell.rectMm, inset)
    const pts = rectPoints(patternH, r.minXMm, r.minYMm, r.maxXMm, r.maxYMm, 20)
    cellQuads.push({ id: cell.id, quad: [applyH(patternH, r.minXMm, r.maxYMm), applyH(patternH, r.maxXMm, r.maxYMm), applyH(patternH, r.maxXMm, r.minYMm), applyH(patternH, r.minXMm, r.minYMm)] })
    if (!pts.every(inPhoto)) {
      warnings.push(`Cell ${cell.id} is outside the photo.`)
      continue
    }
    const m = meanAt(s, pts, 0.1, gain)
    if (m) observations.push({ id: cell.id, lab: toLab(m) })
  }
  const baseMean = meanAt(s, material.flat(), 0.15, gain)
  if (!baseMean) throw new PhotoAnalysisError('No bare material visible around the grid.', 'colour')
  return {
    cardH: cardFit.H,
    cardCorners: cardFit.corners,
    patternH,
    marks,
    correction: { matrix: corr.M, flat, patchDeltaE: corr.patchDeltaE, meanPatchDeltaE: corr.mean },
    observations,
    base: toLab(baseMean),
    cellQuads,
    warnings,
  }
}

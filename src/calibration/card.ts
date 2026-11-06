// SPDX-License-Identifier: MIT
// The Aria Burn colour reference card (BURN-15): our own design, printed by
// the user and photographed next to the burned grid. 24 patches (neutrals,
// wood tones, saturated colours) inside a thick black frame on white paper.
//
// The frame is what detection finds; the patch colours are asymmetric, so the
// card's orientation comes from which of the four rotations fits the colour
// correction best. The white ring between frame and patches is bare paper:
// with the bare material around the grid it gives the flat-field (lighting
// gradient) estimate.
//
// Patch references are the nominal colours of the printed sRGB values. A real
// print differs by printer, ink and paper; for accuracy measure the printed
// card (colorimeter or spectro) and pass the measured Lab values as
// `CardSpec.patches[i].lab`. BURN-12 checks what a nominal card costs.
//
// Card coordinates: mm, origin at the card's top-left corner, y down.

import type { Lab } from '../contract/index.ts'
import { decodeSrgb, linearToLab } from './color.ts'

export interface CardPatch {
  id: string
  /** Printed colour, sRGB8 hex. */
  hex: string
  /** Reference colour (nominal from hex unless measured). */
  lab: Lab
  /** Patch square, card mm. */
  xMm: number
  yMm: number
  sizeMm: number
}

export interface CardSpec {
  id: string
  widthMm: number
  heightMm: number
  /** Outer and inner corners of the black frame (card mm). */
  frameOuter: { x0: number; y0: number; x1: number; y1: number }
  frameInner: { x0: number; y0: number; x1: number; y1: number }
  patches: CardPatch[]
}

const HEX = [
  // Neutrals
  ['n1', '#f3f3f3'], ['n2', '#c8c8c8'], ['n3', '#a0a0a0'], ['n4', '#7a7a7a'], ['n5', '#555555'], ['n6', '#343434'],
  // Near-black, then wood tones light to dark
  ['n7', '#232323'], ['n8', '#141414'], ['w1', '#e8c9a0'], ['w2', '#c49a6c'], ['w3', '#8b5a2b'], ['w4', '#4a2e1a'],
  // Saturated
  ['c1', '#c0392b'], ['c2', '#e67e22'], ['c3', '#f1c40f'], ['c4', '#27ae60'], ['c5', '#16a0c8'], ['c6', '#2e4a9e'],
  // Mixed
  ['m1', '#9b3a8c'], ['m2', '#d8a27f'], ['m3', '#6b7a2a'], ['m4', '#3b2618'], ['m5', '#6e7f96'], ['m6', '#dcdcdc'],
] as const

export function hexToLab(hex: string): Lab {
  const v = parseInt(hex.slice(1), 16)
  return linearToLab([decodeSrgb(((v >> 16) & 255) / 255), decodeSrgb(((v >> 8) & 255) / 255), decodeSrgb((v & 255) / 255)])
}

const PATCH_MM = 12
const GAP_MM = 2
const COLS = 6

/** The card as printed (v1). */
export function referenceCard(): CardSpec {
  const patches: CardPatch[] = HEX.map(([id, hex], i) => ({
    id,
    hex,
    lab: hexToLab(hex),
    xMm: 9 + (i % COLS) * (PATCH_MM + GAP_MM),
    yMm: 9 + Math.floor(i / COLS) * (PATCH_MM + GAP_MM),
    sizeMm: PATCH_MM,
  }))
  return {
    id: 'aria-burn-card-v1',
    widthMm: 100,
    heightMm: 78,
    frameOuter: { x0: 2, y0: 2, x1: 98, y1: 70 },
    frameInner: { x0: 5, y0: 5, x1: 95, y1: 67 },
    patches,
  }
}

/** The card's outer frame corners, clockwise from top-left (card mm). */
export function cardFrameCorners(card: CardSpec): { x: number; y: number }[] {
  const f = card.frameOuter
  return [
    { x: f.x0, y: f.y0 },
    { x: f.x1, y: f.y0 },
    { x: f.x1, y: f.y1 },
    { x: f.x0, y: f.y1 },
  ]
}

/** The card as an SVG to print at 100 % (mm units). */
export function cardSvg(card: CardSpec = referenceCard()): string {
  const f = card.frameOuter
  const i = card.frameInner
  const rects = card.patches.map((p) => `<rect x="${p.xMm}" y="${p.yMm}" width="${p.sizeMm}" height="${p.sizeMm}" fill="${p.hex}"/>`).join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${card.widthMm}mm" height="${card.heightMm}mm" viewBox="0 0 ${card.widthMm} ${card.heightMm}">` +
    `<rect width="${card.widthMm}" height="${card.heightMm}" fill="#ffffff"/>` +
    `<path fill="#000000" fill-rule="evenodd" d="M${f.x0} ${f.y0}H${f.x1}V${f.y1}H${f.x0}Z M${i.x0} ${i.y0}V${i.y1}H${i.x1}V${i.y0}Z"/>` +
    rects +
    `<text x="${f.x0}" y="${card.heightMm - 2.5}" font-family="sans-serif" font-size="3" fill="#000000">Aria Burn reference card v1 · print at 100 % on matte white paper · do not scale</text>` +
    `</svg>`
  )
}

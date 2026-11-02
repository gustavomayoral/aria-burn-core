// SPDX-License-Identifier: MIT
// Material response kinds (COD-250 §3) and the output functions over the
// fluence grid (§4): colour, depth and verdict per cell. This is the CPU
// reference; gl/shaders.ts mirrors it line for line in GLSL.
//
//   char    tone t = clamp((F − toneStart) / (toneEnd − toneStart))^toneGamma,
//           colour = lerp(base, char, t) in Lab; depth = k · max(0, F − ablation).
//   melt    frost t = clamp((F − frostStart) / (frostFull − frostStart)),
//           colour = lerp(base, frost, t); depth = k · max(0, F − removal).
//           Polished edge: a cell below removal with F ≥ frostFull and a
//           4-neighbour at or above removal shows baseColor (glossy, unfrosted).
//   bleach  mark t = clamp((F − markStart) / (markFull − markStart)),
//           colour = lerp(base, mark, t); depth = 0.
// Colours are Lab (D65), converted to sRGB8 per cell.

import { classifyFluence, type Lab, type MaterialProfile } from '../contract/index.ts'

/** Ramp parameters flattened for the shader: colour lerp a→b over [start, end]^gamma, depth above threshold. */
export interface ResponseParams {
  kind: 0 | 1 | 2
  colorA: Lab
  colorB: Lab
  rampStart: number
  rampEnd: number
  gamma: number
  depthThreshold: number
  depthPerFluence: number
  /** Melt only: the polished-edge rule applies. */
  polishedEdge: boolean
  edgeMinFluence: number
}

export const RESPONSE_KIND = { char: 0, melt: 1, bleach: 2 } as const

export function responseParams(material: MaterialProfile): ResponseParams {
  const r = material.response
  switch (r.kind) {
    case 'char':
      return {
        kind: 0,
        colorA: r.baseColor,
        colorB: r.charColor,
        rampStart: r.toneStartJPerMm2,
        rampEnd: r.toneEndJPerMm2,
        gamma: r.toneGamma,
        depthThreshold: r.ablationThresholdJPerMm2,
        depthPerFluence: r.depthMmPerJPerMm2,
        polishedEdge: false,
        edgeMinFluence: Infinity,
      }
    case 'melt':
      return {
        kind: 1,
        colorA: r.baseColor,
        colorB: r.frostColor,
        rampStart: r.frostStartJPerMm2,
        rampEnd: r.frostFullJPerMm2,
        gamma: 1,
        depthThreshold: r.removalThresholdJPerMm2,
        depthPerFluence: r.depthMmPerJPerMm2,
        polishedEdge: true,
        edgeMinFluence: r.frostFullJPerMm2,
      }
    case 'bleach':
      return {
        kind: 2,
        colorA: r.baseColor,
        colorB: r.markColor,
        rampStart: r.markStartJPerMm2,
        rampEnd: r.markFullJPerMm2,
        gamma: 1,
        depthThreshold: Infinity,
        depthPerFluence: 0,
        polishedEdge: false,
        edgeMinFluence: Infinity,
      }
  }
}

export function rampT(p: ResponseParams, fluence: number): number {
  const span = p.rampEnd - p.rampStart
  const t = span > 0 ? (fluence - p.rampStart) / span : fluence >= p.rampStart ? 1 : 0
  const c = Math.min(1, Math.max(0, t))
  return p.gamma === 1 ? c : c ** p.gamma
}

export function cellLab(p: ResponseParams, fluence: number, polished: boolean): Lab {
  if (polished) return p.colorA
  const t = rampT(p, fluence)
  return {
    l: p.colorA.l + (p.colorB.l - p.colorA.l) * t,
    a: p.colorA.a + (p.colorB.a - p.colorA.a) * t,
    b: p.colorA.b + (p.colorB.b - p.colorA.b) * t,
  }
}

export function cellDepthMm(p: ResponseParams, fluence: number): number {
  return fluence > p.depthThreshold ? (fluence - p.depthThreshold) * p.depthPerFluence : 0
}

/** CIELAB (D65) → sRGB8, clamped. Same constants as the GLSL `labToSrgb`. */
export function labToSrgb8(lab: Lab, out: Uint8ClampedArray | number[] = [0, 0, 0], o = 0): typeof out {
  const fy = (lab.l + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200
  const finv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29))
  const X = 0.95047 * finv(fx)
  const Y = finv(fy)
  const Z = 1.08883 * finv(fz)
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z
  const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z
  const enc = (c: number) => {
    const v = Math.min(1, Math.max(0, c))
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
  }
  out[o] = Math.round(enc(r))
  out[o + 1] = Math.round(enc(g))
  out[o + 2] = Math.round(enc(b))
  return out
}

export interface ResponseImages {
  width: number
  height: number
  /** sRGB RGBA8, row 0 = min Y. */
  color: Uint8ClampedArray
  depthMm: Float32Array
  verdict: Uint8Array
}

/**
 * Run the response over `rect` of a fluence buffer of `stride` columns and
 * `rows` rows (neighbours outside the buffer count as zero fluence).
 */
export function respond(
  material: MaterialProfile,
  fluence: Float32Array,
  stride: number,
  rows: number,
  rect: { x: number; y: number; width: number; height: number },
): ResponseImages {
  const p = responseParams(material)
  const { width, height } = rect
  const color = new Uint8ClampedArray(width * height * 4)
  const depthMm = new Float32Array(width * height)
  const verdict = new Uint8Array(width * height)
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= stride || y >= rows ? 0 : fluence[y * stride + x]!)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = rect.x + i
      const y = rect.y + j
      const f = at(x, y)
      const k = j * width + i
      const polished =
        p.polishedEdge &&
        f < p.depthThreshold &&
        f >= p.edgeMinFluence &&
        Math.max(at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)) >= p.depthThreshold
      labToSrgb8(cellLab(p, f, polished), color, k * 4)
      color[k * 4 + 3] = 255
      depthMm[k] = cellDepthMm(p, f)
      verdict[k] = classifyFluence(material, f)
    }
  }
  return { width, height, color, depthMm, verdict }
}

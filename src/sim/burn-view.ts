// SPDX-License-Identifier: MIT
// Burn view shading (COD-259): turns the pipeline's outputs into what the UI
// canvas shows. This is the CPU reference; gl/burn-view-shaders.ts mirrors it
// in GLSL. Everything that varies with the burn (striping, corner scorch,
// relief, halo) comes from the simulated colour, fluence/dose and depth; only
// the unburned material's texture is procedural.
//
//   base      procedural texture per response kind (char → wood grain,
//             melt → cast sheet, bleach → brushed anodizing): a gain g around 1
//             on the profile's baseColor. It fades out as the mark builds:
//             colour = simulated colour + base · (g − 1) · (1 − t), t = response ramp.
//   relief    depth (mm) shaded as a height map: Lambert from the upper left,
//             relative to a flat surface, so engraving reads in the Color view.
//   halo      char only: resin/smoke stain around heavy burns, from the
//             fluence/dose box-blurred to HALO_MM (a mip level on the GPU),
//             where it exceeds the ramp end; strongest just outside the mark.
//   overlay   verdict regions: each bucket's coverage (fraction of cells)
//             box-blurred to REGION_MM (a mip level on the GPU), then the
//             commonest bucket wins; any fire-risk coverage wins outright, so
//             it is never smoothed away. Filled translucent and outlined, so
//             isolated cells merge into areas you can act on. Colours from the
//             COD-253 mock, ordered by burn intensity and colourblind-safe
//             (light → blue → orange → hatched magenta, never red vs green).

import { Verdict, type Lab, type MaterialProfile } from '../contract/index.ts'
import { rampT, responseParams, type ResponseParams } from './response.ts'

/** Distance between verdict-region taps (mm): regions smaller than this merge into their surroundings. */
export const REGION_MM = 0.25
/** Halo blur scale (mm). */
export const HALO_MM = 0.6
/** Strength of the halo stain at its peak. */
export const HALO_ALPHA = 0.42
/** Overlay fill opacity. */
export const OVERLAY_ALPHA = 0.5

export const TEXTURE_KIND = { wood: 0, cast: 1, anodized: 2 } as const
export type TextureKind = keyof typeof TEXTURE_KIND

/** Overlay fill per verdict (sRGB), index = Verdict. Untouched is never drawn. */
export const VERDICT_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [0xec, 0xe8, 0xe0],
  [0x4d, 0x91, 0xd6],
  [0xec, 0x96, 0x28],
  [0xd6, 0x33, 0x6c],
]
/** Fire-risk hatch's dark stripe. */
export const FIRE_DARK_RGB = [0x6e, 0x08, 0x2e] as const
/** Resin/smoke stain colour (Lab). */
export const HALO_LAB: Lab = { l: 30, a: 9, b: 20 }

export interface BurnViewParams {
  texture: TextureKind
  /** sRGB 0..1 of the profile's baseColor. */
  base: [number, number, number]
  halo: [number, number, number]
  rampStart: number
  rampEnd: number
  gamma: number
  /** Halo only for the char kind (wood, leather, paper smoke and resin). */
  haloEnabled: boolean
}

export interface BurnViewOptions {
  relief: boolean
  halo: boolean
  overlay: boolean
}

/** One layer of outputs, texel (i, j) centred at origin + (i + ½, j + ½) · texelMm. Rows from min Y. */
export interface BurnViewLayer {
  width: number
  height: number
  originXMm: number
  originYMm: number
  texelMm: number
  /** sRGB RGBA8 from the response stage. */
  color: Uint8ClampedArray
  /** Fluence, or thermal dose with a thermal model (J/mm²). */
  quantity: Float32Array
  depthMm: Float32Array
  verdict: Uint8Array
}

const finv = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29))
const enc = (c: number) => {
  const v = Math.min(1, Math.max(0, c))
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

/** CIELAB (D65) → sRGB in [0, 1], same as the response stage. */
export function labToSrgb({ l, a, b }: Lab): [number, number, number] {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = 0.95047 * finv(fx)
  const y = finv(fy)
  const z = 1.08883 * finv(fz)
  return [
    enc(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    enc(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    enc(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ]
}

export function textureKind(material: MaterialProfile): TextureKind {
  return material.response.kind === 'char' ? 'wood' : material.response.kind === 'melt' ? 'cast' : 'anodized'
}

export function burnViewParams(material: MaterialProfile): BurnViewParams {
  const p: ResponseParams = responseParams(material)
  return {
    texture: textureKind(material),
    base: labToSrgb(p.colorA),
    halo: labToSrgb(HALO_LAB),
    rampStart: p.rampStart,
    rampEnd: p.rampEnd,
    gamma: p.gamma,
    haloEnabled: material.response.kind === 'char',
  }
}

// Integer hash and value noise, bit-for-bit the same as the GLSL (uint maths wraps mod 2³²).
export function hash2(ix: number, iy: number): number {
  let h = (Math.imul(ix | 0, 0x8da6b343) ^ Math.imul(iy | 0, 0xd8163841)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0
  h = (h ^ (h >>> 15)) >>> 0
  return h / 4294967296
}

export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}

/** Gain on the base colour of unburned material at (x, y) mm. */
export function baseGain(texture: TextureKind, x: number, y: number): number {
  switch (texture) {
    case 'wood': {
      // Grain along X: latewood bands ~1.9 mm apart, warped, with fine fibres.
      const warp = valueNoise(x / 14, y / 3.5)
      const fibre = valueNoise(x / 1.6, y / 0.22)
      const phase = y / 1.9 + 1.6 * warp
      const band = (0.5 + 0.5 * Math.sin(6.2831853 * phase)) ** 3
      return 1.04 - 0.12 * band - 0.05 * (fibre - 0.5)
    }
    case 'cast':
      return 1 + 0.035 * (valueNoise(x / 40, y / 40) - 0.5)
    case 'anodized':
      return 1 + 0.07 * (valueNoise(x / 30, y / 0.05) - 0.5) + 0.025 * (valueNoise(x / 6, y / 6) - 0.5)
  }
}

/** Halo stain amount from the blurred fluence/dose qb at a texel whose own ramp is t. */
export function haloAmount(p: BurnViewParams, qb: number, t: number): number {
  if (!p.haloEnabled || p.rampEnd <= 0) return 0
  const over = Math.min(1, Math.max(0, (qb - 0.35 * p.rampEnd) / p.rampEnd))
  return HALO_ALPHA * over * (1 - t)
}

/**
 * Relief shading factor from the depth gradient (mm per mm, +x right, +y up).
 * Height is −depth, so the surface normal is ∝ (∂depth/∂x, ∂depth/∂y, 1).
 * Lambert from the upper left, relative to a flat surface.
 */
export function reliefShade(gx: number, gy: number): number {
  const lx = -0.48
  const ly = 0.6
  const lz = 0.64
  const lambert = (gx * lx + gy * ly + lz) / Math.hypot(gx, gy, 1)
  return Math.min(1.35, Math.max(0.45, lambert / lz))
}

/** Coverage below which a region counts as untouched (fraction of cells). */
export const REGION_MIN_COVER = 0.2

/**
 * Region from blurred coverage of [under, in range, over, fire risk]: fire
 * risk if it covers anything, otherwise the commonest bucket (ties go to the
 * stronger burn), untouched when burns cover less than REGION_MIN_COVER.
 */
export function regionOf(cover: readonly number[]): number {
  if (cover[3]! > 1e-4) return Verdict.FireRisk
  if (cover[0]! + cover[1]! + cover[2]! < REGION_MIN_COVER) return Verdict.Untouched
  if (cover[2]! >= cover[1]! && cover[2]! >= cover[0]!) return Verdict.Over
  return cover[1]! >= cover[0]! ? Verdict.InRange : Verdict.Under
}

/** One-hot coverage of a verdict: [under, in range, over, fire risk]. */
export function coverOf(v: number): [number, number, number, number] {
  return [v === Verdict.Under ? 1 : 0, v === Verdict.InRange ? 1 : 0, v === Verdict.Over ? 1 : 0, v === Verdict.FireRisk ? 1 : 0]
}

/** Mip level that blurs to `mm` at this texel size (block of 2^level texels). */
export const blurLevel = (mm: number, texelMm: number) => Math.round(Math.log2(Math.max(1, mm / texelMm)))

/**
 * A per-texel field box-blurred to blocks of 2^level texels, sampled
 * bilinearly between block centres: what a mip level gives on the GPU.
 */
export function blurField(width: number, height: number, level: number, channels: number, at: (k: number, c: number) => number) {
  const block = 2 ** level
  const bw = Math.ceil(width / block)
  const bh = Math.ceil(height / block)
  const sums = new Float64Array(bw * bh * channels)
  const counts = new Uint32Array(bw * bh)
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const b = Math.floor(j / block) * bw + Math.floor(i / block)
      for (let c = 0; c < channels; c++) sums[b * channels + c]! += at(j * width + i, c)
      counts[b]!++
    }
  const mean = (bx: number, by: number, c: number) => {
    const b = Math.min(bh - 1, Math.max(0, by)) * bw + Math.min(bw - 1, Math.max(0, bx))
    return counts[b]! ? sums[b * channels + c]! / counts[b]! : 0
  }
  return (px: number, py: number, c: number) => {
    const fx = px / block - 0.5
    const fy = py / block - 0.5
    const x0 = Math.floor(fx)
    const y0 = Math.floor(fy)
    const ax = fx - x0
    const ay = fy - y0
    return (
      (mean(x0, y0, c) * (1 - ax) + mean(x0 + 1, y0, c) * ax) * (1 - ay) +
      (mean(x0, y0 + 1, c) * (1 - ax) + mean(x0 + 1, y0 + 1, c) * ax) * ay
    )
  }
}

/**
 * Shades a layer one texel per pixel. Returns sRGB RGBA8, row 0 = min Y (like
 * the pipeline outputs; flip rows for display).
 */
export function shadeBurnView(layer: BurnViewLayer, params: BurnViewParams, options: BurnViewOptions): Uint8ClampedArray {
  const { width, height, texelMm } = layer
  const out = new Uint8ClampedArray(width * height * 4)
  const halo =
    options.halo && params.haloEnabled ? blurField(width, height, blurLevel(HALO_MM, texelMm), 1, (k) => layer.quantity[k]!) : null
  const cover = options.overlay ? blurField(width, height, blurLevel(REGION_MM, texelMm), 4, (k, c) => coverOf(layer.verdict[k]!)[c]!) : null
  const depth = (i: number, j: number) =>
    layer.depthMm[Math.min(height - 1, Math.max(0, j)) * width + Math.min(width - 1, Math.max(0, i))]!
  const region = (i: number, j: number) => regionOf([0, 1, 2, 3].map((c) => cover!(i + 0.5, j + 0.5, c)))
  for (let j = 0; j < height; j++)
    for (let i = 0; i < width; i++) {
      const k = j * width + i
      const x = layer.originXMm + (i + 0.5) * texelMm
      const y = layer.originYMm + (j + 0.5) * texelMm
      const t = rampT(params, layer.quantity[k]!)
      const g = baseGain(params.texture, x, y) - 1
      let rgb = [0, 1, 2].map((c) => layer.color[k * 4 + c]! / 255 + params.base[c]! * g * (1 - t))
      if (halo) {
        const h = haloAmount(params, halo(i + 0.5, j + 0.5, 0), t)
        rgb = rgb.map((v, c) => v + (params.halo[c]! - v) * h)
      }
      if (options.relief) {
        const gx = (depth(i + 1, j) - depth(i - 1, j)) / (2 * texelMm)
        const gy = (depth(i, j + 1) - depth(i, j - 1)) / (2 * texelMm)
        const s = reliefShade(gx, gy)
        rgb = rgb.map((v) => v * s)
      }
      if (options.overlay) {
        const v = region(i, j)
        if (v !== Verdict.Untouched) {
          const edge = region(i + 1, j) !== v || region(i, j + 1) !== v
          const fire = v === Verdict.FireRisk && ((i + j) & 3) >= 2
          const fill = (fire ? FIRE_DARK_RGB : VERDICT_RGB[v]!).map((c) => c / 255)
          const a = edge ? 0.9 : OVERLAY_ALPHA
          rgb = rgb.map((c, n) => c + (fill[n]! - c) * a)
        }
      }
      for (let c = 0; c < 3; c++) out[k * 4 + c] = Math.round(Math.min(1, Math.max(0, rgb[c]!)) * 255)
      out[k * 4 + 3] = 255
    }
  return out
}

/** A connected patch of fire-risk cells. */
export interface FireSpot {
  /** Centroid (mm). */
  xMm: number
  yMm: number
  /** Area (mm²). */
  areaMm2: number
  /** Bounding box (mm). */
  minXMm: number
  minYMm: number
  maxXMm: number
  maxYMm: number
}

/**
 * Fire-risk patches in a verdict grid (8-connected), largest first. Feeds the
 * fire-risk banner's "Show location".
 */
export function fireSpots(verdict: Uint8Array, width: number, height: number, originXMm: number, originYMm: number, texelMm: number): FireSpot[] {
  const seen = new Uint8Array(width * height)
  const spots: FireSpot[] = []
  const stack: number[] = []
  for (let k = 0; k < verdict.length; k++) {
    if (verdict[k] !== Verdict.FireRisk || seen[k]) continue
    let n = 0
    let sx = 0
    let sy = 0
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    seen[k] = 1
    stack.push(k)
    while (stack.length) {
      const c = stack.pop()!
      const i = c % width
      const j = (c - i) / width
      n++
      sx += i
      sy += j
      x0 = Math.min(x0, i)
      y0 = Math.min(y0, j)
      x1 = Math.max(x1, i)
      y1 = Math.max(y1, j)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const a = i + dx
          const b = j + dy
          if (a < 0 || b < 0 || a >= width || b >= height) continue
          const q = b * width + a
          if (verdict[q] === Verdict.FireRisk && !seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        }
    }
    spots.push({
      xMm: originXMm + (sx / n + 0.5) * texelMm,
      yMm: originYMm + (sy / n + 0.5) * texelMm,
      areaMm2: n * texelMm * texelMm,
      minXMm: originXMm + x0 * texelMm,
      minYMm: originYMm + y0 * texelMm,
      maxXMm: originXMm + (x1 + 1) * texelMm,
      maxYMm: originYMm + (y1 + 1) * texelMm,
    })
  }
  return spots.sort((a, b) => b.areaMm2 - a.areaMm2)
}

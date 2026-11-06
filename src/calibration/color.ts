// SPDX-License-Identifier: MIT
// Colour maths for the photo fit (BURN-15): CIELAB (D65) ↔ XYZ ↔ linear sRGB
// ↔ sRGB8, and colour differences. Same constants as sim/response.ts
// `labToSrgb8`, without the 8-bit rounding, so a fitted cell and a sampled
// photo cell are compared in exactly the space the simulator renders in.
//
// Averaging rule: a camera pixel (and a cell sample) averages reflected light,
// so cells are averaged in linear sRGB and converted to Lab once.

import type { Lab } from '../contract/index.ts'

export type Rgb = [number, number, number]

const XN = 0.95047
const YN = 1
const ZN = 1.08883
const D = 6 / 29

export function labToXyz(lab: Lab): Rgb {
  const fy = (lab.l + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200
  const finv = (t: number) => (t > D ? t * t * t : 3 * D * D * (t - 4 / 29))
  return [XN * finv(fx), YN * finv(fy), ZN * finv(fz)]
}

export function xyzToLab([x, y, z]: Rgb): Lab {
  const f = (t: number) => (t > D * D * D ? Math.cbrt(t) : t / (3 * D * D) + 4 / 29)
  const fx = f(x / XN)
  const fy = f(y / YN)
  const fz = f(z / ZN)
  return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** XYZ (D65) → linear sRGB, unclamped. */
export function xyzToLinear([x, y, z]: Rgb): Rgb {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ]
}

export function linearToXyz([r, g, b]: Rgb): Rgb {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ]
}

export const labToLinear = (lab: Lab): Rgb => xyzToLinear(labToXyz(lab))
export const linearToLab = (rgb: Rgb): Lab => xyzToLab(linearToXyz(rgb))

/** sRGB transfer: encoded 0..1 → linear. */
export const decodeSrgb = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
/** Linear → encoded 0..1 (clamped). */
export function encodeSrgb(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
}

/** sRGB8 → linear lookup. */
export const SRGB8_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) t[i] = decodeSrgb(i / 255)
  return t
})()

export const luminance = (rgb: Rgb): number => 0.2126729 * rgb[0] + 0.7151522 * rgb[1] + 0.072175 * rgb[2]

/** CIE76 ΔE*ab. */
export const deltaE76 = (p: Lab, q: Lab): number => Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b)

/** CIEDE2000 (kL = kC = kH = 1), the ΔE the provenance and the review report. */
export function deltaE2000(p: Lab, q: Lab): number {
  const rad = Math.PI / 180
  const C1 = Math.hypot(p.a, p.b)
  const C2 = Math.hypot(q.a, q.b)
  const Cm = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)))
  const a1 = (1 + G) * p.a
  const a2 = (1 + G) * q.a
  const c1 = Math.hypot(a1, p.b)
  const c2 = Math.hypot(a2, q.b)
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0
    const h = Math.atan2(b, a) / rad
    return h < 0 ? h + 360 : h
  }
  const h1 = hue(p.b, a1)
  const h2 = hue(q.b, a2)
  const dL = q.l - p.l
  const dC = c2 - c1
  let dh = 0
  if (c1 * c2 !== 0) {
    dh = h2 - h1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh * rad) / 2)
  const Lm = (p.l + q.l) / 2
  const cm = (c1 + c2) / 2
  let hm = h1 + h2
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hm += h1 + h2 < 360 ? 360 : -360
    hm /= 2
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2)
  const Sc = 1 + 0.045 * cm
  const Sh = 1 + 0.015 * cm * T
  const Rt = -Math.sin(2 * dTheta * rad) * Rc
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh))
}

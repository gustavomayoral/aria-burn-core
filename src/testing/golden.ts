// SPDX-License-Identifier: MIT
// Golden-image harness: compares a rendered image or scalar field with a
// committed PNG under `golden/`. Run `pnpm golden:update` to (re)bless.
// On a mismatch it writes `<name>.actual.png` and `<name>.diff.png` next to
// the golden (gitignored) so the difference can be inspected.
//
// Real burn renders (COD-264) and the measured COD-254 dataset feed this later;
// for now it is exercised by synthetic cases in golden.test.ts.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

export const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url))

/** 8-bit RGBA image, row-major from the top-left. */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** Single-channel float field (fluence, dose, depth…), row-major from the top-left. */
export interface ScalarField {
  width: number
  height: number
  data: Float32Array
  /** Value mapped to full scale. Values are clamped to [0, max]. */
  max: number
}

export interface GoldenTolerance {
  /** Largest allowed per-channel difference, in 8-bit (RGBA) or 16-bit (field) steps. */
  maxDelta: number
  /** Fraction of pixels allowed to exceed `maxDelta`. */
  maxBadFraction: number
}

export interface GoldenResult {
  pass: boolean
  updated: boolean
  /** Largest per-channel difference seen. */
  maxDelta: number
  badFraction: number
  message: string
}

const DEFAULT_RGBA: GoldenTolerance = { maxDelta: 2, maxBadFraction: 0 }
const DEFAULT_FIELD: GoldenTolerance = { maxDelta: 8, maxBadFraction: 0 }

export const shouldUpdateGoldens = () => process.env.UPDATE_GOLDEN === '1'

/** Encodes a field as 16-bit grayscale so float outputs keep useful precision. */
export function fieldToPng(field: ScalarField): Buffer {
  // pngjs takes 16-bit input as a native-endian Uint16Array and byte-swaps itself.
  const opts = { colorType: 0, inputColorType: 0, bitDepth: 16, inputHasAlpha: false } as const
  const png = new PNG({ width: field.width, height: field.height, ...opts })
  const out = new Uint16Array(field.width * field.height)
  for (let i = 0; i < field.data.length; i++) {
    const v = Math.min(1, Math.max(0, (field.data[i] ?? 0) / field.max))
    out[i] = Math.round(v * 65535)
  }
  png.data = Buffer.from(out.buffer)
  return PNG.sync.write(png, opts)
}

export function rgbaToPng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  return PNG.sync.write(png)
}

interface Decoded {
  width: number
  height: number
  channels: number
  /** Full-scale value per channel (255 or 65535). */
  scale: number
  values: (i: number) => number
}

function decodeRgba(buf: Buffer): Decoded {
  const png = PNG.sync.read(buf)
  return { width: png.width, height: png.height, channels: 4, scale: 255, values: (i) => png.data[i] ?? 0 }
}

function decodeGray16(buf: Buffer): Decoded {
  // pngjs expands to RGBA; with skipRescale the 16-bit samples survive in a Uint16Array.
  const png = PNG.sync.read(buf, { skipRescale: true })
  const data = png.data as unknown as Uint16Array
  return { width: png.width, height: png.height, channels: 1, scale: 65535, values: (i) => data[i * 4] ?? 0 }
}

function diffImage(a: Decoded, bad: Uint8Array): Buffer {
  const png = new PNG({ width: a.width, height: a.height })
  for (let p = 0; p < a.width * a.height; p++) {
    const base = Math.round((a.values(p * a.channels) / a.scale) * 80)
    png.data[p * 4] = bad[p] ? 255 : base
    png.data[p * 4 + 1] = bad[p] ? 0 : base
    png.data[p * 4 + 2] = bad[p] ? 0 : base
    png.data[p * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

function compare(name: string, actualPng: Buffer, decode: (b: Buffer) => Decoded, tol: GoldenTolerance): GoldenResult {
  const goldenPath = join(GOLDEN_DIR, `${name}.png`)
  const actualPath = join(GOLDEN_DIR, `${name}.actual.png`)
  const diffPath = join(GOLDEN_DIR, `${name}.diff.png`)
  rmSync(actualPath, { force: true })
  rmSync(diffPath, { force: true })

  if (shouldUpdateGoldens()) {
    mkdirSync(dirname(goldenPath), { recursive: true })
    writeFileSync(goldenPath, actualPng)
    return { pass: true, updated: true, maxDelta: 0, badFraction: 0, message: `updated ${name}.png` }
  }
  if (!existsSync(goldenPath)) {
    writeFileSync(actualPath, actualPng)
    return {
      pass: false,
      updated: false,
      maxDelta: Infinity,
      badFraction: 1,
      message: `no golden for "${name}"; wrote ${name}.actual.png. Run \`pnpm golden:update\` to bless it.`,
    }
  }

  const expected = decode(readFileSync(goldenPath))
  const actual = decode(actualPng)
  if (expected.width !== actual.width || expected.height !== actual.height) {
    writeFileSync(actualPath, actualPng)
    return {
      pass: false,
      updated: false,
      maxDelta: Infinity,
      badFraction: 1,
      message: `"${name}" is ${actual.width}×${actual.height}, golden is ${expected.width}×${expected.height}`,
    }
  }

  const pixels = actual.width * actual.height
  const bad = new Uint8Array(pixels)
  let maxDelta = 0
  let badCount = 0
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < actual.channels; c++) {
      const i = p * actual.channels + c
      const d = Math.abs(actual.values(i) - expected.values(i))
      if (d > maxDelta) maxDelta = d
      if (d > tol.maxDelta && !bad[p]) {
        bad[p] = 1
        badCount++
      }
    }
  }
  const badFraction = badCount / pixels
  const pass = badFraction <= tol.maxBadFraction
  if (!pass) {
    writeFileSync(actualPath, actualPng)
    writeFileSync(diffPath, diffImage(actual, bad))
  }
  return {
    pass,
    updated: false,
    maxDelta,
    badFraction,
    message: pass
      ? `"${name}" matches (max delta ${maxDelta})`
      : `"${name}" differs: ${badCount} of ${pixels} pixels over ${tol.maxDelta} (max delta ${maxDelta}); see ${name}.diff.png`,
  }
}

export function compareRgbaGolden(name: string, image: RgbaImage, tol: Partial<GoldenTolerance> = {}): GoldenResult {
  return compare(name, rgbaToPng(image), decodeRgba, { ...DEFAULT_RGBA, ...tol })
}

export function compareFieldGolden(name: string, field: ScalarField, tol: Partial<GoldenTolerance> = {}): GoldenResult {
  return compare(name, fieldToPng(field), decodeGray16, { ...DEFAULT_FIELD, ...tol })
}

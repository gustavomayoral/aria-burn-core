// SPDX-License-Identifier: MIT
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOLDEN_DIR, compareFieldGolden, compareRgbaGolden, shouldUpdateGoldens, type ScalarField } from './golden.ts'

// Synthetic stand-in for a deposit pass: a Gaussian spot dragged along a line
// at constant power, integrated analytically per cell. Replaced by real
// pipeline renders in COD-264.
function gaussianLineField(width: number, height: number): ScalarField {
  const data = new Float32Array(width * height)
  const sigma = 3
  const x0 = 8
  const x1 = width - 8
  const yc = height / 2
  const erf = (x: number) => {
    // Abramowitz–Stegun 7.1.26: deterministic across platforms, accurate enough here.
    const t = 1 / (1 + 0.3275911 * Math.abs(x))
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
    return x >= 0 ? y : -y
  }
  let max = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const along = 0.5 * (erf((x + 0.5 - x0) / (Math.SQRT2 * sigma)) - erf((x + 0.5 - x1) / (Math.SQRT2 * sigma)))
      const across = Math.exp(-((y + 0.5 - yc) ** 2) / (2 * sigma * sigma))
      const v = along * across
      data[y * width + x] = v
      if (v > max) max = v
    }
  }
  return { width, height, data, max }
}

function checkerboard(width: number, height: number) {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0
      const i = (y * width + x) * 4
      data[i] = on ? 232 : 30
      data[i + 1] = on ? 121 : 28
      data[i + 2] = on ? 61 : 26
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('golden-image harness', () => {
  it('matches the Gaussian line field golden', () => {
    const r = compareFieldGolden('gaussian-line', gaussianLineField(96, 48))
    expect(r.pass, r.message).toBe(true)
  })

  it('matches the RGBA checkerboard golden', () => {
    const r = compareRgbaGolden('checkerboard', checkerboard(32, 32))
    expect(r.pass, r.message).toBe(true)
  })

  it.skipIf(shouldUpdateGoldens())('flags a field that drifts past tolerance and writes a diff', () => {
    const field = gaussianLineField(96, 48)
    for (let i = 0; i < 96 * 4; i++) field.data[i] = field.max
    const r = compareFieldGolden('gaussian-line', field)
    try {
      expect(r.pass).toBe(false)
      expect(r.badFraction).toBeGreaterThan(0)
      expect(existsSync(join(GOLDEN_DIR, 'gaussian-line.diff.png'))).toBe(true)
    } finally {
      rmSync(join(GOLDEN_DIR, 'gaussian-line.actual.png'), { force: true })
      rmSync(join(GOLDEN_DIR, 'gaussian-line.diff.png'), { force: true })
    }
  })

  it.skipIf(shouldUpdateGoldens())('tolerates noise inside maxDelta', () => {
    const field = gaussianLineField(96, 48)
    for (let i = 0; i < field.data.length; i += 7) field.data[i] = (field.data[i] ?? 0) + (field.max * 4) / 65535
    const r = compareFieldGolden('gaussian-line', field)
    expect(r.pass, r.message).toBe(true)
  })

  it.skipIf(shouldUpdateGoldens())('fails with a hint when the golden is missing', () => {
    const r = compareRgbaGolden('does-not-exist', checkerboard(8, 8))
    rmSync(join(GOLDEN_DIR, 'does-not-exist.actual.png'), { force: true })
    expect(r.pass).toBe(false)
    expect(r.message).toMatch(/golden:update/)
  })
})

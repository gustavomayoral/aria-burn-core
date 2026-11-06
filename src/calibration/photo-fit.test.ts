// SPDX-License-Identifier: MIT
// Unit tests for the photo fit's pieces (BURN-15): colour maths, homography,
// the solver, card detection, the forward model's dose split, and a
// noise-free fit. The full photo round trips are in
// src/testing/calibration-roundtrip-*.test.ts.

import { describe, expect, it } from 'vitest'
import { machine, provisionalMaterial, sampleJob, THERMAL_TEST_STEP, trueMaterial } from '../testing/calibration-roundtrip.ts'
import { blurCpu, depositCpu } from '../sim/cpu.ts'
import { kernelSigma, type MaterialProfile } from '../contract/index.ts'
import { thermalFor } from '../sim/thermal.ts'
import {
  analysePhoto,
  applyH,
  cardFrameCorners,
  cardSvg,
  cellFields,
  deltaE2000,
  findCardFrames,
  fitHomography,
  fitKernel,
  fitMaterial,
  generatePattern,
  invertH,
  labToLinear,
  levenbergMarquardt,
  linearToLab,
  predictCells,
  referenceCard,
  renderPattern,
  splitEnergies,
  syntheticPhoto,
} from './index.ts'

describe('colour', () => {
  it('Lab ↔ linear sRGB round-trips', () => {
    for (const lab of [{ l: 50, a: 20, b: -30 }, { l: 81, a: 7, b: 20 }, { l: 8, a: 0, b: 0 }]) {
      const back = linearToLab(labToLinear(lab))
      expect(back.l).toBeCloseTo(lab.l, 4)
      expect(back.a).toBeCloseTo(lab.a, 4)
      expect(back.b).toBeCloseTo(lab.b, 4)
    }
  })
  it('CIEDE2000 matches Sharma, Wu & Dalal (2005) test pairs', () => {
    const pairs: [number, number, number, number, number, number, number][] = [
      [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
      [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
      [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
      [50, 2.5, 0, 73, 25, -18, 27.1492],
      [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
      [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
    ]
    for (const [l1, a1, b1, l2, a2, b2, de] of pairs) expect(deltaE2000({ l: l1, a: a1, b: b1 }, { l: l2, a: a2, b: b2 })).toBeCloseTo(de, 3)
  })
})

describe('geometry and solver', () => {
  it('fits a homography exactly from 4 points and inverts it', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 0, y: 70 }]
    const dst = [{ x: 210, y: 120 }, { x: 900, y: 180 }, { x: 860, y: 640 }, { x: 170, y: 600 }]
    const H = fitHomography(src, dst)
    src.forEach((p, i) => {
      const q = applyH(H, p.x, p.y)
      expect(q.x).toBeCloseTo(dst[i]!.x, 6)
      expect(q.y).toBeCloseTo(dst[i]!.y, 6)
    })
    const back = applyH(invertH(H), 860, 640)
    expect(back.x).toBeCloseTo(100, 6)
    expect(back.y).toBeCloseTo(70, 6)
  })
  it('Levenberg–Marquardt solves a small nonlinear fit', () => {
    const xs = [0, 1, 2, 3, 4, 5]
    const ys = xs.map((x) => 2.5 * Math.exp(-0.7 * x) + 0.3)
    const r = levenbergMarquardt((p) => Float64Array.from(xs.map((x, i) => p[0]! * Math.exp(-p[1]! * x) + p[2]! - ys[i]!)), Float64Array.from([1, 0.1, 0]))
    expect(r.p[0]).toBeCloseTo(2.5, 5)
    expect(r.p[1]).toBeCloseTo(0.7, 5)
    expect(r.p[2]).toBeCloseTo(0.3, 5)
  })
})

describe('reference card', () => {
  it('has 24 distinct patches inside the frame and prints as SVG', () => {
    const card = referenceCard()
    expect(card.patches).toHaveLength(24)
    for (const p of card.patches) {
      expect(p.xMm).toBeGreaterThanOrEqual(card.frameInner.x0 + 3)
      expect(p.xMm + p.sizeMm).toBeLessThanOrEqual(card.frameInner.x1 - 3)
      expect(p.yMm).toBeGreaterThanOrEqual(card.frameInner.y0 + 3)
      expect(p.yMm + p.sizeMm).toBeLessThanOrEqual(card.frameInner.y1 - 3)
    }
    const labs = card.patches.map((p) => p.lab)
    for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) expect(deltaE2000(labs[i]!, labs[j]!)).toBeGreaterThan(3)
    const svg = cardSvg(card)
    expect(svg).toContain('width="100mm"')
    expect(svg.match(/<rect /g)).toHaveLength(25)
  })
})

describe('forward model', () => {
  // A small grid keeps the thermal step quick.
  const start = provisionalMaterial('black-cast-acrylic.json')
  const pattern = generatePattern('grid', machine, start, { pattern: { powersPct: [40, 100], feedsMmPerMin: [6000, 2000], cellMm: 4 } })
  const store = sampleJob(pattern, machine)

  it('splits the dose exactly: flash + bulk / flashK is the thermal step’s dose at any onset', () => {
    // Without absorption feedback the bulk term doesn't depend on the response, so one run
    // at the starting onset predicts the dose of a run at another onset.
    const other: MaterialProfile = structuredClone(start)
    if (other.thermal.kind !== 'peakTemperature') throw new Error('acrylic has a thermal model')
    other.thermal.rampOnsetK = 590
    const split = splitEnergies(store, machine, start, THERMAL_TEST_STEP)
    const th = thermalFor(store, machine, other, kernelSigma(machine.spot, other.sigmaHeatMm), THERMAL_TEST_STEP)!
    const flashK = (590 - 293) / (other.response as { frostStartJPerMm2: number }).frostStartJPerMm2
    let worst = 0
    for (let i = 0; i < store.count; i += 97) {
      const want = th.eDose[i]!
      const got = split.flash[i]! + split.bulk1![i]! / flashK
      worst = Math.max(worst, Math.abs(got - want) / Math.max(Math.abs(want), 1e-12))
    }
    expect(worst).toBeLessThan(1e-5)
  })

  it('a cell’s field is the core’s own deposit and blur over the cell', () => {
    // No thermal model: the field is the absorbed fluence, compared with depositCpu + blurCpu over the whole job.
    const al = provisionalMaterial('black-anodized-aluminum.json')
    const fields = cellFields(store, machine, al, pattern.cells, { columns: 4 })
    const c = pattern.cells[0]!
    const pitch = fields.pitchMm
    const { separable } = fitKernel(machine, al, pitch)
    const pad = 2
    const grid = {
      originXMm: Math.floor(c.rectMm.minXMm / pitch) * pitch - pad,
      originYMm: Math.floor(c.rectMm.minYMm / pitch) * pitch - pad,
      pitchMm: pitch,
      width: Math.ceil((c.rectMm.maxXMm - c.rectMm.minXMm + 2 * pad) / pitch) + 2,
      height: Math.ceil((c.rectMm.maxYMm - c.rectMm.minYMm + 2 * pad) / pitch) + 2,
    }
    const dep = depositCpu(store, store.count, grid, { x: 0, y: 0, width: grid.width, height: grid.height }, al.absorption)
    const { afterV } = blurCpu(dep.data, grid.width, grid.height, separable)
    // The cell's mean field equals the reference's mean over the same inner rect.
    const inner = { x0: c.rectMm.minXMm + 0.2 * 4, x1: c.rectMm.maxXMm - 0.2 * 4, y0: c.rectMm.minYMm + 0.2 * 4, y1: c.rectMm.maxYMm - 0.2 * 4 }
    let sum = 0
    let n = 0
    for (let j = 0; j < grid.height; j++)
      for (let i = 0; i < grid.width; i++) {
        const x = grid.originXMm + (i + 0.5) * pitch
        const y = grid.originYMm + (j + 0.5) * pitch
        if (x >= inner.x0 && x < inner.x1 && y >= inner.y0 && y < inner.y1) {
          sum += afterV[j * grid.width + i]!
          n++
        }
      }
    const f = fields.cells[0]!
    const mean = f.flash.reduce((a, b) => a + b, 0) / f.flash.length
    expect(Math.abs(mean - sum / n) / (sum / n)).toBeLessThan(0.01)
  })

  it('a noise-free fit recovers the true parameters', () => {
    const truth = trueMaterial(provisionalMaterial('black-anodized-aluminum.json'))
    const al = provisionalMaterial('black-anodized-aluminum.json')
    const p = generatePattern('grid', machine, al, { pattern: { powersPct: [20, 40, 60, 80, 100], feedsMmPerMin: [4000, 2500, 1500, 900], cellMm: 4 } })
    const s = sampleJob(p, machine)
    const obs = predictCells(cellFields(s, machine, truth, p.cells), truth)
    const fit = fitMaterial({ cells: p.cells, store: s, machine, material: al, observations: obs, base: truth.response.baseColor })
    const r = fit.material.response
    const t = truth.response
    if (r.kind !== 'bleach' || t.kind !== 'bleach') throw new Error('bleach')
    expect(r.markStartJPerMm2 / t.markStartJPerMm2).toBeCloseTo(1, 2)
    expect(r.markFullJPerMm2 / t.markFullJPerMm2).toBeCloseTo(1, 2)
    expect(fit.meanDeltaE).toBeLessThan(0.05)
    expect(fit.material.provenance.source).toBe('calibrated')
  }, 60_000)
})

describe('detection', () => {
  it('finds the card frame in any rotation, and the pattern’s fiducials', () => {
    const al = provisionalMaterial('black-anodized-aluminum.json')
    const p = generatePattern('grid', machine, al, { pattern: { powersPct: [30, 100], feedsMmPerMin: [3000, 1000], cellMm: 4 } })
    const s = sampleJob(p, machine)
    const b = p.boundsMm
    const render = renderPattern(s, machine, al, { minXMm: b.minXMm - 12, minYMm: b.minYMm - 12, maxXMm: b.maxXMm + 12, maxYMm: b.maxYMm + 12 }, { finePitchMm: 0.05, outPitchMm: 0.1 })
    for (const rotationDeg of [0, 90, 200]) {
      const sp = syntheticPhoto(render, al.response.baseColor, { seed: rotationDeg + 1, rotationDeg, perspective: 0.03, widthPx: 1600, heightPx: 1200, blurPx: 0.8 })
      const frames = findCardFrames(sp.photo)
      expect(frames.length).toBeGreaterThan(0)
      const card = referenceCard()
      const truth = cardFrameCorners(card).map((c) => applyH(sp.cardH, c.x, c.y))
      // One candidate (the board's edge can be another) has every true corner within 1.5 px.
      const err = (f: (typeof frames)[number]) => Math.max(...truth.map((t) => Math.min(...f.corners.map((c) => Math.hypot(c.x - t.x, c.y - t.y)))))
      expect(Math.min(...frames.map(err))).toBeLessThan(1.5)
      const a = analysePhoto(sp.photo, p, { marksLighter: true })
      for (const m of p.marks.filter((k) => k.kind === 'fiducial')) {
        const got = applyH(a.patternH, m.centerMm.xMm, m.centerMm.yMm)
        const want = applyH(sp.patternH, m.centerMm.xMm, m.centerMm.yMm)
        expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(1)
      }
      // Card corners come back in card order (the right rotation).
      a.cardCorners.forEach((c, i) => expect(Math.hypot(c.x - truth[i]!.x, c.y - truth[i]!.y)).toBeLessThan(1.5))
    }
  }, 120_000)
})

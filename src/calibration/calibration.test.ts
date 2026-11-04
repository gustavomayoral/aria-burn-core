// SPDX-License-Identifier: MIT
// Calibration patterns (BURN-32) on every catalog frame + module and every
// provisional material: inside the bed, inside the machine's power and speed
// ranges, and each cell burned with the settings it records. The Rust parser
// and GRBL planner check of the same G-code lives in aria-burn
// (src-tauri/src/job.rs `calibration_patterns_parse_and_plan_clean`).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { beamOn, combineMachine, decodeSampleBatch, readSample, type MachineProfile, type Move } from '../contract/index.ts'
import { CATALOG_FRAMES, modulesForFrame } from '../profiles/catalog/index.ts'
import { interimSampler, loadMachineProfile, loadMaterialProfile } from '../sim/index.ts'
import {
  FONT_CHARS,
  MIN_FEED_MM_PER_MIN,
  PATTERN_KINDS,
  PatternFitError,
  cellAt,
  fillFeedCap,
  generatePattern,
  overscanMm,
  patternContext,
  textStrokes,
  type CalibrationPattern,
  type PatternKind,
} from './index.ts'

const prov = (n: string) => readFileSync(new URL(`../profiles/provisional/${n}`, import.meta.url), 'utf8')
const MATERIALS = ['birch-ply.json', 'black-cast-acrylic.json', 'black-anodized-aluminum.json'].map((f) => loadMaterialProfile(prov(f)))
const DEFAULT_MACHINE = loadMachineProfile(prov('machine-10w-diode.json'))
const PAIRS = CATALOG_FRAMES.flatMap((f) => modulesForFrame(f).map((m) => ({ id: `${f.id}+${m.id}`, machine: combineMachine(f, m) })))

const EPS = 1e-6
const inside = (x: number, y: number, r: { minXMm: number; minYMm: number; maxXMm: number; maxYMm: number }, pad = EPS) =>
  x >= r.minXMm - pad && x <= r.maxXMm + pad && y >= r.minYMm - pad && y <= r.maxYMm + pad

/** Beam-on moves, with their start points. */
function burns(moves: readonly Move[]): { x0: number; y0: number; m: Move }[] {
  const out: { x0: number; y0: number; m: Move }[] = []
  let x = 0
  let y = 0
  for (const m of moves) {
    if (beamOn(m)) out.push({ x0: x, y0: y, m })
    x = m.xMm
    y = m.yMm
  }
  return out
}

const LINE = /^(; .*|G21 G90|M4 S0|M5 S0|M2|G0 X-?\d+(\.\d+)? Y-?\d+(\.\d+)?|G1 X\d+(\.\d+)? Y\d+(\.\d+)?( F\d+)?( S\d+(\.\d)?)?)$/

function checkPattern(p: CalibrationPattern, machine: MachineProfile) {
  const ctx = patternContext(machine, MATERIALS[0]!)
  const bed = p.machine.bedMm
  expect(bed).toEqual(ctx.bedMm)
  // G-code: only the dialect the toolpath writes; one line per move, in order.
  // Plain loops collect problems: an expect() per move is too slow over the whole catalog.
  const problems: string[] = []
  const lines = p.gcode.trimEnd().split('\n')
  for (const l of lines) if (!LINE.test(l)) problems.push(`unexpected line: ${l}`)
  expect(p.job.source.lineCount).toBe(lines.length)
  const bedRect = { minXMm: 0, minYMm: 0, maxXMm: bed.x, maxYMm: bed.y }
  const maxRate = Math.max(machine.maxRateMmPerMin.x, machine.maxRateMmPerMin.y)
  for (const m of p.job.moves) {
    if (!lines[m.line - 1]!.startsWith(m.kind === 'g0' ? 'G0 ' : 'G1 ')) problems.push(`line ${m.line} is not a ${m.kind}`)
    // Bed: every point visited (moves are straight, so the samples between are inside too).
    if (!inside(m.xMm, m.yMm, bedRect)) problems.push(`line ${m.line} (${m.xMm}, ${m.yMm}) is off the bed`)
    // Machine ranges.
    if (m.s > machine.sMax) problems.push(`line ${m.line} S${m.s} > $30`)
    if (m.kind === 'g1' && (m.feedMmPerMin < MIN_FEED_MM_PER_MIN - 1 || m.feedMmPerMin > maxRate)) problems.push(`line ${m.line} F${m.feedMmPerMin}`)
    if (problems.length > 5) break
  }
  expect(problems).toEqual([])
  expect(bed.x).toBeLessThanOrEqual(machine.travelMm.x)
  expect(bed.y).toBeLessThanOrEqual(machine.travelMm.y)
  // Cells: inside the burn, and every beam-on move within a cell carries its S and F.
  expect(p.cells.length).toBeGreaterThan(0)
  const b = burns(p.job.moves)
  for (const c of p.cells) {
    expect(inside(c.rectMm.minXMm, c.rectMm.minYMm, p.burnBoundsMm, 1e-3) && inside(c.rectMm.maxXMm, c.rectMm.maxYMm, p.burnBoundsMm, 1e-3)).toBe(true)
    const within = b.filter(({ x0, y0, m }) => inside(x0, y0, c.rectMm, 1e-3) && inside(m.xMm, m.yMm, c.rectMm, 1e-3))
    expect(within.length, c.id).toBeGreaterThan(0)
    const wrong = within.filter(({ m }) => m.s !== c.settings.s || m.feedMmPerMin !== c.settings.feedMmPerMin)
    expect(wrong.map(({ m }) => `line ${m.line}`), c.id).toEqual([])
    const s = c.settings
    if (s.op === 'fill') {
      const axis = s.scan!
      expect(s.feedMmPerMin).toBeLessThanOrEqual(machine.maxRateMmPerMin[axis])
      expect(s.energyJPerMm2).toBeCloseTo(s.powerW / ((s.feedMmPerMin / 60) * s.intervalMm!), 2)
    }
  }
  // Cell ids are unique, and cellAt finds each cell from its centre.
  expect(new Set(p.cells.map((c) => c.id)).size).toBe(p.cells.length)
  for (const c of p.cells) {
    const hit = cellAt(p, (c.rectMm.minXMm + c.rectMm.maxXMm) / 2, (c.rectMm.minYMm + c.rectMm.maxYMm) / 2)
    expect(hit?.id).toBe(c.id)
  }
}

describe.each(PAIRS)('$id', ({ machine }) => {
  it.each(PATTERN_KINDS)('%s: inside the bed and the machine limits, every material', (kind) => {
    for (const material of MATERIALS) checkPattern(generatePattern(kind, machine, material), machine)
  }, 20_000)
})

describe('power × speed grid', () => {
  it('spans the material from under to over within the machine range', () => {
    for (const { machine } of PAIRS)
      for (const material of MATERIALS) {
        const p = generatePattern('grid', machine, material)
        const a = material.absorption
        const e = p.cells.map((c) => c.settings.energyJPerMm2 * a)
        const t = material.response
        const [under, over] =
          t.kind === 'char' ? [t.toneStartJPerMm2, t.toneEndJPerMm2] : t.kind === 'melt' ? [t.frostStartJPerMm2, t.removalThresholdJPerMm2] : [t.markStartJPerMm2, t.damageThresholdJPerMm2]
        // Unless the frame's feed limit stops the fastest row short of it.
        const fastest = Math.max(...p.cells.map((c) => c.settings.feedMmPerMin))
        if (fastest < fillFeedCap(patternContext(machine, material), 'x') - 50) expect(Math.min(...e), p.machine.name).toBeLessThan(under * 1.05)
        expect(Math.max(...e), p.machine.name).toBeGreaterThan(over)
        // Columns are power, rows are feed; energy grows right and down.
        for (const c of p.cells) {
          const right = p.cells.find((k) => k.row === c.row && k.col === c.col! + 1)
          const down = p.cells.find((k) => k.col === c.col && k.row === c.row! + 1)
          if (right) expect(right.settings.energyJPerMm2).toBeGreaterThan(c.settings.energyJPerMm2)
          if (down) expect(down.settings.energyJPerMm2).toBeGreaterThan(c.settings.energyJPerMm2)
        }
      }
  })

  it('honours custom steps and a smaller sheet', () => {
    const p = generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!, {
      bedMm: { x: 120, y: 100 },
      originMm: { x: 30, y: 20 },
      pattern: { powersPct: [20, 60, 100], feedsMmPerMin: [3000, 1500] },
    })
    expect(p.cells.map((c) => c.settings.powerPct)).toEqual([20, 60, 100, 20, 60, 100])
    expect(p.cells.map((c) => c.settings.feedMmPerMin)).toEqual([3000, 3000, 3000, 1500, 1500, 1500])
    expect(p.machine.bedMm).toEqual({ x: 120, y: 100 })
    expect(p.burnBoundsMm.minXMm).toBeCloseTo(30, 3)
    expect(p.burnBoundsMm.minYMm).toBeCloseTo(20, 3)
  })

  it('shrinks to fit a small sheet, and refuses one it can’t fit', () => {
    const big = generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!)
    const small = generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!, { bedMm: { x: 85, y: 50 } })
    const w = (p: CalibrationPattern) => p.cells[0]!.rectMm.maxXMm - p.cells[0]!.rectMm.minXMm
    expect(w(small)).toBeLessThan(w(big))
    expect(() => generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!, { bedMm: { x: 30, y: 30 } })).toThrow(PatternFitError)
  })

  it('is deterministic', () => {
    const a = generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!)
    const b = generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!)
    expect(a.gcode).toBe(b.gcode)
  })
})

describe('equal-energy pairs', () => {
  it('reaches each row’s energy with power and feed in proportion', () => {
    for (const { machine } of PAIRS)
      for (const material of MATERIALS) {
        const p = generatePattern('equal-energy', machine, material)
        const groups = new Map<string, typeof p.cells>()
        for (const c of p.cells) groups.set(c.group!, [...(groups.get(c.group!) ?? []), c])
        expect(groups.size).toBeGreaterThan(0)
        for (const cells of groups.values()) {
          expect(cells.length).toBeGreaterThanOrEqual(2)
          const target = cells[0]!.extra!.targetEnergyJPerMm2 as number
          for (const c of cells) expect(Math.abs(c.settings.energyJPerMm2 - target) / target).toBeLessThan(0.01)
          const feeds = cells.map((c) => c.settings.feedMmPerMin)
          expect(Math.max(...feeds) / Math.min(...feeds)).toBeGreaterThanOrEqual(1.9)
        }
      }
  })
})

describe('overscan', () => {
  it('keeps the head at the programmed feed wherever a fill burns', () => {
    // Small variants on a wider spot, so the interim sampler's step (spot σ ÷ 3) keeps the run short.
    const machine = { ...DEFAULT_MACHINE, spot: { sigmaXMm: 0.08, sigmaYMm: 0.06, angleDeg: 90 } }
    const small: [PatternKind, Record<string, unknown>][] = [
      ['grid', { powersPct: [20, 60, 100], feedsMmPerMin: [10000, 3000], cellMm: 3 }],
      ['equal-energy', { cellMm: 4 }],
      ['line-interval', { cellMm: 3 }],
      ['fill-size', { sizesMm: [2, 5] }],
      ['marks', { patchMm: 3 }],
    ]
    for (const [kind, pattern] of small) {
      const p = generatePattern(kind, machine, MATERIALS[0]!, { pattern })
      const plan = interimSampler.plan(p.job, machine, 1)
      const fills = p.cells.filter((c) => c.settings.op === 'fill')
      let checked = 0
      const slow: string[] = []
      for (const buf of plan.batches) {
        const batch = decodeSampleBatch(buf)
        for (let i = 0; i < batch.sampleCount; i++) {
          const s = readSample(batch, i)
          if (s.powerW <= 0) continue
          const c = fills.find((k) => inside(s.xMm, s.yMm, k.rectMm, 1e-3))
          if (!c) continue
          if (s.speedMmPerS * 60 < c.settings.feedMmPerMin * 0.98) slow.push(`${c.id} at ${(s.speedMmPerS * 60).toFixed(0)} mm/min`)
          checked++
        }
      }
      expect(slow.slice(0, 5), kind).toEqual([])
      expect(checked, kind).toBeGreaterThan(100)
    }
  }, 30_000)

  it('grows with feed squared over acceleration', () => {
    const ctx = patternContext(DEFAULT_MACHINE, MATERIALS[0]!)
    expect(overscanMm(ctx, 6000, 'x')).toBeGreaterThan((100 * 100) / (2 * 1000))
    expect(overscanMm(ctx, 12000, 'x')).toBeGreaterThan(3.9 * overscanMm(ctx, 6000, 'x') - 2)
  })
})

describe('marks', () => {
  it('puts four fiducials and an orientation dot outside every pattern’s cells', () => {
    for (const kind of PATTERN_KINDS) {
      const p = generatePattern(kind, DEFAULT_MACHINE, MATERIALS[0]!)
      const fid = p.marks.filter((m) => m.kind === 'fiducial')
      expect(fid.map((m) => m.id).sort()).toEqual(['fid-bl', 'fid-br', 'fid-tl', 'fid-tr'])
      expect(p.marks.filter((m) => m.kind === 'orientation')).toHaveLength(1)
      for (const m of fid) for (const c of p.cells) expect(inside(m.centerMm.xMm, m.centerMm.yMm, c.rectMm, 0)).toBe(false)
    }
    expect(generatePattern('grid', DEFAULT_MACHINE, MATERIALS[0]!, { registration: false }).marks).toHaveLength(0)
  })

  it('has a tone wedge from light to dark, a card area and a scale bar', () => {
    const p = generatePattern('marks', DEFAULT_MACHINE, MATERIALS[0]!)
    const e = p.cells.map((c) => c.settings.energyJPerMm2)
    for (let i = 1; i < e.length; i++) expect(e[i]!).toBeGreaterThan(e[i - 1]!)
    for (const c of p.cells) expect(Math.abs(c.settings.energyJPerMm2 - (c.extra!.targetEnergyJPerMm2 as number)) / c.settings.energyJPerMm2).toBeLessThan(0.05)
    expect(p.marks.map((m) => m.kind).sort()).toEqual(['card', 'fiducial', 'fiducial', 'fiducial', 'fiducial', 'orientation', 'scale'])
  })
})

describe('label font', () => {
  it('draws every glyph inside its box', () => {
    for (const ch of FONT_CHARS.trim()) {
      for (const stroke of textStrokes(ch, 0, 0, 6)) for (const [x, y] of stroke) expect(x >= 0 && x <= 4 && y >= 0 && y <= 6, ch).toBe(true)
    }
    expect(() => textStrokes('ä', 0, 0, 2)).toThrow()
  })
})

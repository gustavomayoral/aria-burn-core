// SPDX-License-Identifier: MIT
// Places a pattern on the bed, adds registration fiducials around it, and
// writes its G-code and job model.
//
// Adding a pattern: write a PatternGenerator in patterns.ts, add its kind to PatternKind and
// PATTERNS. Placement, fiducials, the bed check and the cell records come from
// here; the catalog-wide tests (calibration.test.ts here, the parser and
// planner check in aria-burn) pick it up from PATTERNS.

import type { BoundsMm, MachineProfile, MaterialProfile } from '../contract/index.ts'
import { defaultIntervalMm, machineInfo, overscanMm, patternContext, type ContextOptions, type PatternContext } from './context.ts'
import { PATTERNS, markFill, type PatternDraft, type PatternGenerator } from './patterns.ts'
import { Toolpath } from './toolpath.ts'
import { PatternFitError, type CalibrationPattern, type CellSettings, type PatternCell, type PatternKind, type PatternMark } from './types.ts'

export const PATTERN_KINDS = Object.keys(PATTERNS) as PatternKind[]

export interface GenerateOptions extends ContextOptions {
  /**
   * Lower-left corner of the burned area (mm). Default: as close to the bed
   * origin as the overscan allows, plus `marginMm`.
   */
  originMm?: { x: number; y: number }
  /** Clearance from the bed edges for the default placement (mm). Default 5. */
  marginMm?: number
  /** Corner fiducials around the pattern for the photo fit. Default true. */
  registration?: boolean
  /** Pattern options over the defaults (see each generator's options type). */
  pattern?: Record<string, unknown>
}

export const patternGenerator = (kind: PatternKind): PatternGenerator<Record<string, unknown>> =>
  PATTERNS[kind] as unknown as PatternGenerator<Record<string, unknown>>

/** The defaults a pattern would use on this machine and material, for a settings form. */
export function patternDefaults(kind: PatternKind, machine: MachineProfile, material: MaterialProfile, options: ContextOptions = {}): Record<string, unknown> {
  return patternGenerator(kind).defaults(patternContext(machine, material, options))
}

const FIDUCIAL_MM = 3
const FIDUCIAL_GAP_MM = 3

/** Four corner fiducials and an orientation dot beside the bottom-left one, around `burn` (local mm). */
function fiducials(ctx: PatternContext, burn: BoundsMm, scale: number): { marks: PatternMark[]; draw: (tp: Toolpath) => void } {
  const f = Math.max(2, FIDUCIAL_MM * scale)
  const g = FIDUCIAL_GAP_MM
  const settings = markFill(ctx, defaultIntervalMm(ctx))
  const x0 = burn.minXMm - g - f
  const x1 = burn.maxXMm + g
  const y0 = burn.minYMm - g - f
  const y1 = burn.maxYMm + g
  const square = (id: string, kind: PatternMark['kind'], x: number, y: number, size: number): PatternMark => {
    const r = burnedRect({ minXMm: x, minYMm: y, maxXMm: x + size, maxYMm: y + size }, settings)
    return { id, kind, rectMm: r, centerMm: { xMm: (r.minXMm + r.maxXMm) / 2, yMm: (r.minYMm + r.maxYMm) / 2 }, settings }
  }
  const marks = [
    square('fid-bl', 'fiducial', x0, y0, f),
    square('fid-br', 'fiducial', x1, y0, f),
    square('fid-tr', 'fiducial', x1, y1, f),
    square('fid-tl', 'fiducial', x0, y1, f),
    square('orient', 'orientation', x0 + f + f / 2, y0, f / 2),
  ]
  return {
    marks,
    draw(tp) {
      for (const m of marks) tp.fillRect(m.rectMm, settings, overscanMm(ctx, settings.feedMmPerMin, 'x'))
    },
  }
}

/**
 * The area a fill actually burns: the raster's last line falls on a whole
 * number of intervals, so the far edge across the scan moves in to it.
 */
export function burnedRect(r: BoundsMm, s: CellSettings): BoundsMm {
  if (s.op !== 'fill' || !s.intervalMm) return r
  const iv = s.intervalMm
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  if (s.scan === 'y') return { ...r, maxXMm: r3(r.minXMm + Math.floor((r.maxXMm - r.minXMm) / iv + 1e-6) * iv) }
  return { ...r, maxYMm: r3(r.minYMm + Math.floor((r.maxYMm - r.minYMm) / iv + 1e-6) * iv) }
}

const moveRect = (b: BoundsMm, dx: number, dy: number): BoundsMm => {
  const r = (v: number) => Math.round(v * 1000) / 1000
  return { minXMm: r(b.minXMm + dx), minYMm: r(b.minYMm + dy), maxXMm: r(b.maxXMm + dx), maxYMm: r(b.maxYMm + dy) }
}

interface Laid {
  draft: PatternDraft
  extra: { marks: PatternMark[]; draw: (tp: Toolpath) => void } | null
  extent: BoundsMm
  burn: BoundsMm
}

function layOut(ctx: PatternContext, gen: PatternGenerator<Record<string, unknown>>, opts: Record<string, unknown>, scale: number, registration: boolean): Laid {
  const draft = gen.build(ctx, opts, scale)
  for (const c of draft.cells) c.rectMm = burnedRect(c.rectMm, c.settings)
  const probe = new Toolpath(ctx, { measure: true })
  probe.start()
  draft.draw(probe)
  let extra = null
  if (registration) {
    extra = fiducials(ctx, probe.burnExtent, scale)
    extra.draw(probe)
  }
  return { draft, extra, extent: probe.extent, burn: probe.burnExtent }
}

/**
 * Generates a calibration pattern for a machine and material. Throws
 * PatternFitError when it can't be made to fit the bed.
 */
export function generatePattern(kind: PatternKind, machine: MachineProfile, material: MaterialProfile, options: GenerateOptions = {}): CalibrationPattern {
  const ctx = patternContext(machine, material, options)
  const gen = patternGenerator(kind)
  const opts = { ...gen.defaults(ctx), ...(options.pattern ?? {}) }
  const registration = options.registration ?? true
  const margin = options.marginMm ?? 5

  // Shrink until it fits; overscan and labels don't scale, cells do.
  let laid: Laid | null = null
  let room = { x: 0, y: 0 }
  for (const scale of [1, 0.85, 0.7, 0.55, 0.4]) {
    const l = layOut(ctx, gen, opts, scale, registration)
    const w = l.extent.maxXMm - l.extent.minXMm
    const h = l.extent.maxYMm - l.extent.minYMm
    const ox = options.originMm ? options.originMm.x - (l.burn.minXMm - l.extent.minXMm) : margin
    const oy = options.originMm ? options.originMm.y - (l.burn.minYMm - l.extent.minYMm) : margin
    room = { x: ctx.bedMm.x - Math.max(0, ox), y: ctx.bedMm.y - Math.max(0, oy) }
    if (ox >= 0 && oy >= 0 && w <= room.x && h <= room.y) {
      laid = l
      break
    }
  }
  if (!laid) throw new PatternFitError(`${gen.title} doesn't fit the ${ctx.bedMm.x} × ${ctx.bedMm.y} mm bed at this position (room ${room.x.toFixed(0)} × ${room.y.toFixed(0)} mm)`)

  const { draft, extra, extent, burn } = laid
  // Local → bed: the motion extent's corner lands on the origin (or the burn's corner on originMm).
  const dx = options.originMm ? options.originMm.x - burn.minXMm : margin - extent.minXMm
  const dy = options.originMm ? options.originMm.y - burn.minYMm : margin - extent.minYMm

  const cells: PatternCell[] = draft.cells.map((c) => ({ ...c, rectMm: moveRect(c.rectMm, dx, dy) }))
  const marks: PatternMark[] = [...draft.marks, ...(extra?.marks ?? [])].map((m) => ({
    ...m,
    rectMm: moveRect(m.rectMm, dx, dy),
    centerMm: { xMm: Math.round((m.centerMm.xMm + dx) * 1000) / 1000, yMm: Math.round((m.centerMm.yMm + dy) * 1000) / 1000 },
  }))

  const tp = new Toolpath(ctx)
  tp.comment(`Aria Burn calibration pattern: ${draft.title}`)
  tp.comment(`kind ${kind} v1, machine ${machine.name}, material ${material.id}`)
  if (gen.measures) tp.comment(`measures ${gen.measures.on}.${gen.measures.field}${gen.measures.inContract ? '' : ' (not in the contract yet)'}`)
  if (kind === 'focus-height') {
    const z = opts.zMode === 'z-axis'
    tp.comment(z ? 'Z: relative steps (G91 G0 Z) on a motorised Z, + = head up; the job ends at the Z it started at.' : 'Z: no Z is commanded. The job pauses (M0) before each line; move the head as the comment says, then resume.')
    tp.comment('Start with the head focused on the work surface as usual.')
  }
  for (const c of cells) {
    const s = c.settings
    const r = c.rectMm
    tp.comment(
      `cell ${c.id} S${s.s} F${s.feedMmPerMin}${s.intervalMm ? ` I${s.intervalMm}` : ''} E${s.energyJPerMm2} rect ${r.minXMm} ${r.minYMm} ${r.maxXMm} ${r.maxYMm}`,
    )
  }
  for (const m of marks) tp.comment(`mark ${m.id} center ${m.centerMm.xMm} ${m.centerMm.yMm}`)
  tp.start()
  tp.setOffset(dx, dy)
  draft.draw(tp)
  extra?.draw(tp)
  tp.setOffset(0, 0)
  tp.end()

  const job = tp.job(`${kind}.gcode`)
  const e = tp.extent
  const b = tp.burnExtent
  return {
    format: 'aria-burn-pattern',
    version: 1,
    kind,
    title: draft.title,
    pick: gen.pick ?? 'best-cell',
    ...(gen.measures ? { measures: { ...gen.measures } } : {}),
    options: draft.options,
    machine: machineInfo(ctx),
    material: { id: material.id, name: material.name, kind: material.response.kind, absorption: material.absorption },
    boundsMm: e,
    burnBoundsMm: b,
    cells,
    marks,
    gcode: tp.gcode(),
    job,
    estimatedTimeS: tp.estimatedTimeS,
  }
}

/** The cell whose rectangle contains a point (mm), if any; the nearest within `slopMm` otherwise. */
export function cellAt(pattern: Pick<CalibrationPattern, 'cells'>, xMm: number, yMm: number, slopMm = 0.5): PatternCell | null {
  let best: PatternCell | null = null
  let bestD = slopMm
  for (const c of pattern.cells) {
    const r = c.rectMm
    const dxo = Math.max(r.minXMm - xMm, 0, xMm - r.maxXMm)
    const dyo = Math.max(r.minYMm - yMm, 0, yMm - r.maxYMm)
    const d = Math.hypot(dxo, dyo)
    if (d === 0) return c
    if (d <= bestD) {
      best = c
      bestD = d
    }
  }
  return best
}

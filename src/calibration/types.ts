// SPDX-License-Identifier: MIT
// Calibration patterns (BURN-32): what a generated pattern records about
// itself, so a sim result or a photo of the burn can be matched back to the
// settings each cell was burned with.
//
// Plain TypeScript, not part of the Rust ↔ webview contract: patterns are
// generated and read in the webview (and by BURN-15's fit), and reach Rust only
// as G-code text.

import type { BoundsMm, JobModel, LaserMode, Vec2Mm } from '../contract/index.ts'

/** Pattern kinds. BURN-47 adds firing threshold, focus height and scan offset. */
export type PatternKind = 'grid' | 'equal-energy' | 'line-interval' | 'corners' | 'fill-size' | 'marks'

/** Scan axis of a raster fill: lines run along machine X or machine Y. */
export type ScanAxis = 'x' | 'y'

/** The settings one cell (or shape, or mark) was burned with. */
export interface CellSettings {
  /** fill = bidirectional raster; line = vector strokes. */
  op: 'fill' | 'line'
  laser: Exclude<LaserMode, 'off'>
  /** Commanded S, raw units (0..$30). */
  s: number
  /** S as a percentage of $30. */
  powerPct: number
  /** Optical power at this S through the module's power curve (W). */
  powerW: number
  feedMmPerMin: number
  /** Fill only: line interval (mm). */
  intervalMm?: number
  /** Fill only: scan axis. */
  scan?: ScanAxis
  /**
   * Nominal incident energy per area (J/mm²): P / (v · interval) for a fill,
   * P / (v · √(2π) · σ⊥) on the centre line of a stroke. Before absorption,
   * at the programmed speed (the overscan keeps the head at speed over a fill).
   */
  energyJPerMm2: number
  /** Line only: incident energy per length of stroke, P / v (J/mm). */
  lineEnergyJPerMm?: number
}

export interface PatternCell {
  /** Unique within the pattern, e.g. "r2c5". */
  id: string
  /** Engraved or shown label, e.g. "45% 1800". */
  label: string
  /** Area the cell burns, absolute machine mm. */
  rectMm: BoundsMm
  settings: CellSettings
  /** Grid position, when the pattern is a grid of cells. */
  row?: number
  col?: number
  /** Cells meant to be compared with each other (equal-energy level, scan axis…). */
  group?: string
  /** Pattern-specific facts about the cell (corner angles, fill area…). */
  extra?: Record<string, number | string | number[]>
}

/** A mark the photo fit (BURN-15) locates: fiducials, tone wedge patches, card area. */
export interface PatternMark {
  id: string
  kind: 'fiducial' | 'orientation' | 'tone' | 'card' | 'scale' | 'label'
  rectMm: BoundsMm
  centerMm: Vec2Mm
  settings?: CellSettings
}

export interface PatternMachineInfo {
  name: string
  frameId?: string
  moduleId?: string
  opticalPowerW: number
  sMax: number
  bedMm: { x: number; y: number }
}

export interface CalibrationPattern {
  format: 'aria-burn-pattern'
  version: 1
  kind: PatternKind
  title: string
  /** The options the pattern was generated from, after defaults and fitting to the bed. */
  options: Record<string, unknown>
  machine: PatternMachineInfo
  material: { id: string; name: string; kind: string; absorption: number }
  /** Every point the head visits (overscan included), absolute mm. */
  boundsMm: BoundsMm
  /** Where the beam is on. */
  burnBoundsMm: BoundsMm
  cells: PatternCell[]
  marks: PatternMark[]
  /** G-code for the machine (GRBL, mm, absolute, M4). */
  gcode: string
  /**
   * The job model the parser makes of `gcode` (same moves, lines and modal
   * state), so the core can simulate a pattern without the Rust parser. The
   * app checks the two agree for every catalog machine.
   */
  job: JobModel
  /** Estimated burn time at programmed feeds, beam-off moves included (s); a lower bound. */
  estimatedTimeS: number
}

/** Thrown when a pattern can't be laid out within the bed. */
export class PatternFitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatternFitError'
  }
}

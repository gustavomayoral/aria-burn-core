// SPDX-License-Identifier: MIT
// Forward model of the photo fit (BURN-15): what the simulator predicts inside
// each cell of a calibration pattern, split so that response parameters can be
// fitted without rerunning the simulation.
//
// The response kinds read one number per grid cell, the fluence or (with a
// peakTemperature model) the thermal dose. Neither depends on the ramp, the
// colours or the depth parameters, except through two routes:
//
//   1. the dose's bulk term scales with 1 / flashKPerJPerMm2, and flashK =
//      (rampOnsetK − ambientK) ÷ rampStart (contract thermal.ts). Per sample,
//      eDose = eAbs · flash + eAbs · ΔT_bulk · bulkGain / a with bulkGain ∝
//      1 / flashK, so after one thermal run
//          dose(θ) = D_flash + D_bulk1 / flashK(θ)
//      where D_flash and D_bulk1 (the bulk part at flashK = 1) go through the
//      same deposit and blur as every other energy. Exact.
//   2. absorption feedback (char with thermal.absorptionAtFullChar): the
//      absorbed energy follows the char level, which follows the ramp. The
//      fit handles this by rerunning the thermal step at the fitted
//      parameters and refitting (fit.ts), a fixed-point iteration.
//
// Each cell's inner region (inset from its edges, so blur halos, the melt
// polished edge and a bidirectional scan offset stay out) is deposited and
// blurred with the core's own CPU functions at `pitchMm`, and a strided subset
// of its grid cells is kept: every row (line stripes run along the scan), a
// few dozen columns.
//
// The physics is the core's, unchanged: deposit (depositCpu), blur (blurCpu
// with the job kernel), thermal step (thermalFor, CPU or a caller's GPU step).

import {
  coarsePitchKernel,
  gridPitchMm,
  kernelRadiusMm,
  kernelSigma,
  type BoundsMm,
  type GridSpec,
  type MachineProfile,
  type MaterialProfile,
} from '../contract/index.ts'
import { blurCpu, depositCpu } from '../sim/cpu.ts'
import { separableKernel, type SeparableKernel } from '../sim/kernel.ts'
import type { SampleStore } from '../sim/sample-store.ts'
import { cachedFlashTable, peakTemperatureModel, thermalFor, thermalStatics, type ThermalResult, type ThermalStep } from '../sim/thermal.ts'
import type { PatternCell } from './types.ts'

export interface ForwardOptions {
  /** Grid pitch of the forward model (mm). Default 2 × the detail pitch (10 µm on the provisional diode). */
  pitchMm?: number
  /** Inset of the sampled region from each cell edge, as a fraction of the cell size. Default 0.2. */
  insetFraction?: number
  /** Columns kept per cell. Default 24. */
  columns?: number
  /** Thermal step (the app passes its GPU step); default the CPU reference. */
  thermalStep?: ThermalStep
}

export const DEFAULT_INSET_FRACTION = 0.2

/** One cell's predicted fields at its kept grid points. */
export interface CellField {
  id: string
  /** Commanded S as a fraction of $30 (the power-curve fit groups cells by it). */
  sFraction: number
  /**
   * Dose part that does not depend on the response (J/mm²): the flash term
   * with a thermal model, the absorbed fluence without one.
   */
  flash: Float32Array
  /** Bulk dose at flashK = 1 (J/mm² · K/(J/mm²)); all zero without a thermal model. */
  bulk: Float32Array
  /** Highest bulk temperature (K, absolute) over the cell's sampled region; ambient or NaN without a thermal model. */
  bulkMaxK: number
}

export interface CellFields {
  pitchMm: number
  insetFraction: number
  /** flashK of the thermal run the fields were split from; null without a thermal model. */
  thermal: { ambientK: number } | null
  cells: CellField[]
}

/** Inner rect of a cell (absolute mm). */
export function innerRect(r: BoundsMm, inset: number): BoundsMm {
  const dx = (r.maxXMm - r.minXMm) * inset
  const dy = (r.maxYMm - r.minYMm) * inset
  return { minXMm: r.minXMm + dx, minYMm: r.minYMm + dy, maxXMm: r.maxXMm - dx, maxYMm: r.maxYMm - dy }
}

/** The core's job kernel at `pitchMm` (contract coarsePitchKernel, as setupJob builds it). */
export function fitKernel(machine: MachineProfile, material: MaterialProfile, pitchMm: number): { separable: SeparableKernel; radiusMm: number } {
  const kernel = kernelSigma(machine.spot, material.sigmaHeatMm)
  const k = coarsePitchKernel(kernel, pitchMm, gridPitchMm(machine.spot))
  return { separable: separableKernel(k, pitchMm), radiusMm: kernelRadiusMm(kernel) }
}

/**
 * Per-sample dose energies split as in route 1 above: `flash` (J) and
 * `bulk1` (J at flashK = 1). Without a thermal model `flash` is E · absorption
 * and `bulk1` is null.
 */
export function splitEnergies(
  store: SampleStore,
  machine: MachineProfile,
  material: MaterialProfile,
  step?: ThermalStep,
): { flash: Float32Array; bulk1: Float32Array | null; thermal: ThermalResult | null } {
  const n = store.count
  const kernel = kernelSigma(machine.spot, material.sigmaHeatMm)
  const th = thermalFor(store, machine, material, kernel, step)
  const model = peakTemperatureModel(material)
  if (!th || !model || !th.plan) {
    const flash = new Float32Array(n)
    for (let i = 0; i < n; i++) flash[i] = store.xye[i * 3 + 2]! * material.absorption
    return { flash, bulk1: null, thermal: null }
  }
  const table = cachedFlashTable(machine, kernel, model, th.plan.nearS)
  const statics = thermalStatics(store, th.plan, table, material, model)
  const flash = new Float32Array(n)
  const bulk1 = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const f = th.eAbs[i]! * statics.flash[i]!
    flash[i] = f
    bulk1[i] = (th.eDose[i]! - f) * th.flashK
  }
  return { flash, bulk1, thermal: th }
}

/**
 * Samples bucketed on a coarse square lattice, so a small rect deposits only
 * the samples near it (depositCpu walks every sample it is given).
 */
export class SampleIndex {
  private readonly buckets = new Map<number, number[]>()
  constructor(
    readonly store: SampleStore,
    readonly bucketMm = 2,
  ) {
    const { xye, count } = store
    for (let i = 0; i < count; i++) {
      const k = this.key(Math.floor(xye[i * 3]! / bucketMm), Math.floor(xye[i * 3 + 1]! / bucketMm))
      let b = this.buckets.get(k)
      if (!b) this.buckets.set(k, (b = []))
      b.push(i)
    }
  }
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768)
  }
  /** A store holding only the samples within `marginMm` of `rect`, and their energies. */
  subset(rect: BoundsMm, marginMm: number, energies: Float32Array): { store: SampleStore; energies: Float32Array } {
    const B = this.bucketMm
    const idx: number[] = []
    for (let i = Math.floor((rect.minXMm - marginMm) / B); i <= Math.floor((rect.maxXMm + marginMm) / B); i++)
      for (let j = Math.floor((rect.minYMm - marginMm) / B); j <= Math.floor((rect.maxYMm + marginMm) / B); j++) {
        const b = this.buckets.get(this.key(i, j))
        if (b) for (const k of b) idx.push(k)
      }
    const xye = new Float32Array(idx.length * 3)
    const e = new Float32Array(idx.length)
    const src = this.store.xye
    idx.forEach((k, n) => {
      xye[n * 3] = src[k * 3]!
      xye[n * 3 + 1] = src[k * 3 + 1]!
      xye[n * 3 + 2] = src[k * 3 + 2]!
      e[n] = energies[k]!
    })
    return { store: { xye, count: idx.length } as unknown as SampleStore, energies: e }
  }
}

/** Blur `energies` over `rect` (absolute mm) and return the blurred field of the rect's cells (row-major, row 0 = min Y). */
export function blurredRect(
  store: SampleStore | SampleIndex,
  energies: Float32Array,
  rect: BoundsMm,
  pitchMm: number,
  separable: SeparableKernel,
  radiusMm: number,
): { grid: GridSpec; data: Float32Array } {
  if (store instanceof SampleIndex) {
    const sub = store.subset(rect, radiusMm + 2 * pitchMm, energies)
    return blurredRect(sub.store, sub.energies, rect, pitchMm, separable, radiusMm)
  }
  // Lattice-aligned cells covering the rect, padded by the kernel radius.
  const x0 = Math.floor(rect.minXMm / pitchMm)
  const y0 = Math.floor(rect.minYMm / pitchMm)
  const x1 = Math.ceil(rect.maxXMm / pitchMm)
  const y1 = Math.ceil(rect.maxYMm / pitchMm)
  const pad = Math.ceil(radiusMm / pitchMm) + 1
  const grid: GridSpec = { originXMm: (x0 - pad) * pitchMm, originYMm: (y0 - pad) * pitchMm, pitchMm, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad }
  const padded = { x: 0, y: 0, width: grid.width, height: grid.height }
  const dep = depositCpu(store, store.count, grid, padded, 1, energies)
  const { afterV } = blurCpu(dep.data, grid.width, grid.height, separable)
  const w = x1 - x0
  const h = y1 - y0
  const data = new Float32Array(w * h)
  for (let j = 0; j < h; j++) data.set(afterV.subarray((j + pad) * grid.width + pad, (j + pad) * grid.width + pad + w), j * w)
  return { grid: { originXMm: x0 * pitchMm, originYMm: y0 * pitchMm, pitchMm, width: w, height: h }, data }
}

function maxBulkOver(th: ThermalResult, r: BoundsMm): number {
  const { bulkK, plan } = th
  if (!bulkK || !plan) return th.ambientK
  const g = plan.grid
  const i0 = Math.max(0, Math.floor((r.minXMm - g.originXMm) / g.pitchMm))
  const i1 = Math.min(g.width - 1, Math.floor((r.maxXMm - g.originXMm) / g.pitchMm))
  const j0 = Math.max(0, Math.floor((r.minYMm - g.originYMm) / g.pitchMm))
  const j1 = Math.min(g.height - 1, Math.floor((r.maxYMm - g.originYMm) / g.pitchMm))
  let m = 0
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) m = Math.max(m, bulkK[j * g.width + i]!)
  return th.ambientK + m
}

/**
 * The forward fields of `cells`: one thermal run (if the material has a
 * thermal model) at `material`'s parameters, then per-cell deposit and blur.
 */
export function cellFields(
  store: SampleStore,
  machine: MachineProfile,
  material: MaterialProfile,
  cells: readonly PatternCell[],
  options: ForwardOptions = {},
): CellFields {
  const pitchMm = options.pitchMm ?? 2 * gridPitchMm(machine.spot)
  const inset = options.insetFraction ?? DEFAULT_INSET_FRACTION
  const columns = options.columns ?? 24
  const { flash, bulk1, thermal } = splitEnergies(store, machine, material, options.thermalStep)
  const { separable, radiusMm } = fitKernel(machine, material, pitchMm)
  const index = new SampleIndex(store)
  const out: CellField[] = []
  for (const cell of cells) {
    const r = innerRect(cell.rectMm, inset)
    const f = blurredRect(index, flash, r, pitchMm, separable, radiusMm)
    const b = bulk1 ? blurredRect(index, bulk1, r, pitchMm, separable, radiusMm) : null
    const { width, height } = f.grid
    const step = Math.max(1, Math.floor(width / columns))
    const cols: number[] = []
    for (let i = Math.floor(step / 2); i < width; i += step) cols.push(i)
    const n = cols.length * height
    const fa = new Float32Array(n)
    const ba = new Float32Array(n)
    let k = 0
    for (let j = 0; j < height; j++)
      for (const i of cols) {
        fa[k] = f.data[j * width + i]!
        ba[k] = b ? b.data[j * width + i]! : 0
        k++
      }
    out.push({
      id: cell.id,
      sFraction: cell.settings.s / Math.max(1, machine.sMax),
      flash: fa,
      bulk: ba,
      bulkMaxK: thermal ? maxBulkOver(thermal, r) : NaN,
    })
  }
  return { pitchMm, insetFraction: inset, thermal: thermal ? { ambientK: thermal.ambientK } : null, cells: out }
}

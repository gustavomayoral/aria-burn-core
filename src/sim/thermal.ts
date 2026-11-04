// SPDX-License-Identifier: MIT
// Thermal step (COD-258): per-sample deposit energies for fluence and thermal
// dose, plus the bulk-temperature map. `ThermalStep` is the seam: the
// peakTemperature model (Option B, contract thermal.ts) implements it here on
// the CPU and in gl/gl-thermal.ts on the GPU; an empirical speed correction
// (Option A) would implement it with no grid at all (eDose = eAbs · c(dwell)).
//
// This file is the CPU reference: the oracle the GPU path is checked against
// and the headless path for Vitest.

import {
  depthSolver,
  depthStep,
  diffusionTaps,
  flashKPerJPerMm2,
  flashSpeedFactor,
  flashTable,
  gaussianTaps,
  mirrorIndex,
  planLiveThermal,
  planThermal,
  sameThermalPlan,
  sigmaAcross,
  THERMAL_MIN_SPEED_MM_PER_S,
  type FlashTable,
  type KernelSigma,
  type MachineProfile,
  type MaterialProfile,
  type PeakTemperatureModel,
  type ThermalPlan,
  type ThermalPlanOptions,
} from '../contract/index.ts'
import { rampT, responseParams, type ResponseParams } from './response.ts'
import type { SampleStore } from './sample-store.ts'

/** What the fine pipeline needs from a thermal step. */
export interface ThermalResult {
  /** Samples covered (a prefix of the store). */
  count: number
  storeVersion: number
  /** Per-sample absorbed energy (J): fluence deposit. */
  eAbs: Float32Array
  /** Per-sample dose energy (J): eAbs · w_i, the dose deposit. */
  eDose: Float32Array
  /** Bulk-temperature map (K above ambient) on `plan.grid`, or null for a step without a grid. */
  bulkK: Float32Array | null
  plan: ThermalPlan | null
  ambientK: number
  /** flashKPerJPerMm2: dose → equivalent peak temperature rise. */
  flashK: number
  /** True once the per-sample data is gone with a lost WebGL context (GPU step, BURN-39); thermalFor recomputes it. */
  readonly lost?: boolean
}

/**
 * Which thermal plan a step uses: the job plan (planThermal), or while a job
 * streams the live plan (planLiveThermal, BURN-35) that holds across refreshes.
 */
export type ThermalPlanning = 'job' | 'live'

export interface ThermalStep {
  /**
   * Steps with the same id compute the same model (the CPU reference and the
   * WebGL2 port of peakTemperature), so they share one cached result.
   */
  readonly id: string
  run(store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning?: ThermalPlanning): ThermalResult
  /**
   * Optional (BURN-35): continue `prev`, this step's latest result for the
   * same store, machine, material, kernel and planning, over the samples
   * appended to the store since. Returns null when it can't (another plan,
   * state gone, store not a pure append); thermalFor then runs in full. The
   * result equals run() on the current store; `prev` is superseded.
   */
  extend?(prev: ThermalResult, store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning?: ThermalPlanning): ThermalResult | null
}

export const peakTemperatureModel = (material: MaterialProfile): PeakTemperatureModel | null =>
  material.thermal.kind === 'peakTemperature' ? material.thermal : null

/** Per-sample inputs of the peakTemperature step that don't depend on the thermal state. */
export interface ThermalStatics {
  /** Flash factor A_i (dimensionless). */
  flash: Float32Array
  /** B'_i = v·√(2π)·σ⊥ / (flashK · P_i): ΔT_bulk · B' / a is the bulk term of w_i. */
  bulkGain: Float32Array
  /** First sample of each bin, plus a final count. */
  binStart: Uint32Array
}

const tableCache = new WeakMap<PeakTemperatureModel, Map<string, FlashTable>>()

export function cachedFlashTable(machine: MachineProfile, kernel: KernelSigma, thermal: PeakTemperatureModel, windowS: number): FlashTable {
  let byKey = tableCache.get(thermal)
  if (!byKey) tableCache.set(thermal, (byKey = new Map()))
  const s = machine.spot
  const key = [s.sigmaXMm, s.sigmaYMm, s.angleDeg, kernel.sigmaUMm, kernel.sigmaVMm, kernel.angleDeg, windowS].join()
  let t = byKey.get(key)
  if (!t) byKey.set(key, (t = flashTable(s, kernel, thermal, windowS)))
  return t
}

export function thermalPlanFor(store: SampleStore, thermal: PeakTemperatureModel, options: ThermalPlanOptions = {}, planning: ThermalPlanning = 'job'): ThermalPlan {
  const b = store.burnBounds ?? { minXMm: 0, minYMm: 0, maxXMm: 0, maxYMm: 0 }
  const last = store.count ? store.tS[store.count - 1]! : 0
  return (planning === 'live' ? planLiveThermal : planThermal)(b, last, store.sampledUntilS, thermal, options)
}

/** The statics loop's memo (last speed, direction, flash factor and σ⊥), carried across ranges so a resumed range matches a full one. */
export interface StaticsMemo {
  v: number
  ux: number
  uy: number
  flash: number
  sigma: number
}

export const freshStaticsMemo = (): StaticsMemo => ({ v: NaN, ux: NaN, uy: NaN, flash: 0, sigma: 0 })

/**
 * Flash factor and bulk gain of samples [from, to) into `flash` / `bulkGain`
 * (indexed by sample), continuing `memo` (updated in place). Sample i's
 * direction reads samples i ± 1, so a sample's value changes once a next
 * sample arrives: resume at the last bin's first sample (BURN-35).
 */
export function staticsRange(
  store: SampleStore,
  from: number,
  to: number,
  table: FlashTable,
  material: MaterialProfile,
  thermal: PeakTemperatureModel,
  memo: StaticsMemo,
  flash: Float32Array,
  bulkGain: Float32Array,
): void {
  const n = store.count
  const { xye, tS, dtS, speedMmPerS } = store
  const flashK = flashKPerJPerMm2(material, thermal)
  const root2pi = Math.sqrt(2 * Math.PI)
  // Consecutive samples of a move share speed and direction, so the table
  // lookup and σ⊥ are memoised on (speed, unit direction).
  let lastV = memo.v
  let lastUx = memo.ux
  let lastUy = memo.uy
  let lastFlash = memo.flash
  let lastSigma = memo.sigma
  for (let i = from; i < to; i++) {
    const v = Math.max(speedMmPerS[i]!, THERMAL_MIN_SPEED_MM_PER_S)
    // Direction from the neighbours in the same continuous run (no beam-off gap between them).
    const lo = i > 0 && tS[i]! - tS[i - 1]! <= (dtS[i - 1]! + dtS[i]!) * 0.51 + 1e-9 ? i - 1 : i
    const hi = i + 1 < n && tS[i + 1]! - tS[i]! <= (dtS[i]! + dtS[i + 1]!) * 0.51 + 1e-9 ? i + 1 : i
    let ux = 1
    let uy = 0
    if (lo !== hi) {
      const dx = xye[hi * 3]! - xye[lo * 3]!
      const dy = xye[hi * 3 + 1]! - xye[lo * 3 + 1]!
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 0) {
        ux = dx / len
        uy = dy / len
      }
    }
    // f32 positions make the neighbour direction jitter by ~1e-3 on short steps; the table is 15° per row.
    if (v !== lastV || Math.abs(ux - lastUx) > 2e-3 || Math.abs(uy - lastUy) > 2e-3) {
      const phi = Math.atan2(uy, ux)
      lastFlash = flashSpeedFactor(table, v, phi)
      lastSigma = sigmaAcross(table.kernelCov, phi)
      lastV = v
      lastUx = ux
      lastUy = uy
    }
    flash[i] = lastFlash
    const p = xye[i * 3 + 2]! / Math.max(dtS[i]!, 1e-12)
    bulkGain[i] = p > 0 ? (v * root2pi * lastSigma) / (flashK * p) : 0
  }
  memo.v = lastV
  memo.ux = lastUx
  memo.uy = lastUy
  memo.flash = lastFlash
  memo.sigma = lastSigma
}

/** binStart[k] for k ≥ fromBin (binStart[fromBin] = fromSample), plus the final count. */
export function fillBinStarts(store: SampleStore, plan: ThermalPlan, binStart: Uint32Array, fromBin: number, fromSample: number): void {
  const n = store.count
  let s = fromSample
  for (let k = fromBin; k < plan.binCount; k++) {
    binStart[k] = s
    const end = (k + 1) * plan.binS
    while (s < n && store.tS[s]! < end) s++
  }
  binStart[plan.binCount] = n
}

export function thermalStatics(
  store: SampleStore,
  plan: ThermalPlan,
  table: FlashTable,
  material: MaterialProfile,
  thermal: PeakTemperatureModel,
): ThermalStatics {
  const n = store.count
  const flash = new Float32Array(n)
  const bulkGain = new Float32Array(n)
  staticsRange(store, 0, n, table, material, thermal, freshStaticsMemo(), flash, bulkGain)
  const binStart = new Uint32Array(plan.binCount + 1)
  fillBinStarts(store, plan, binStart, 0, 0)
  return { flash, bulkGain, binStart }
}

/** Absorption at a char level t ∈ [0, 1] (feedback only for char with absorptionAtFullChar). */
export function absorptionAt(material: MaterialProfile, thermal: PeakTemperatureModel, charT: number): number {
  const full = thermal.absorptionAtFullChar
  return full === undefined ? material.absorption : material.absorption + (full - material.absorption) * charT
}

export interface CpuGridSnapshot {
  state: Float32Array
  doseAcc: Float32Array
  injectedJ: number
  pendingS: number
  live: boolean
}

/** The peakTemperature thermal grid, stepped bin by bin on the CPU. */
export class CpuThermalGrid {
  readonly cells: number
  /** Excess temperature (K), [layer][cell]. */
  readonly state: Float32Array
  /** Accumulated dose (J/mm²), no diffusion: the char level for absorption feedback. */
  readonly doseAcc: Float32Array
  readonly bulkK: Float32Array
  /** Heat injected in the current bin, before its lateral spread (land). */
  private readonly fresh: Float32Array
  private freshPending = false
  private readonly scratch: Float32Array
  injectedJ = 0
  private pendingS = 0
  private live = false

  constructor(
    readonly plan: ThermalPlan,
    readonly heatCapacityJPerMm3K: number,
  ) {
    const { width, height } = plan.grid
    this.cells = width * height
    this.state = new Float32Array(plan.layerMm.length * this.cells)
    this.doseAcc = new Float32Array(this.cells)
    this.bulkK = new Float32Array(this.cells)
    this.scratch = new Float32Array(this.cells)
    this.fresh = new Float32Array(plan.layerMm.length * this.cells)
  }

  /** The grid's time state, to resume a run from (BURN-35); fresh heat is always landed between bins. */
  snapshot(): CpuGridSnapshot {
    return { state: this.state.slice(), doseAcc: this.doseAcc.slice(), injectedJ: this.injectedJ, pendingS: this.pendingS, live: this.live }
  }

  restore(s: CpuGridSnapshot): void {
    this.state.set(s.state)
    this.doseAcc.set(s.doseAcc)
    this.injectedJ = s.injectedJ
    this.pendingS = s.pendingS
    this.live = s.live
  }

  /** Σ ρc · ΔT · volume over every layer and cell (J). */
  energyJ(): number {
    const { grid, layerMm } = this.plan
    let e = 0
    for (let k = 0; k < layerMm.length; k++) {
      let s = 0
      for (let c = 0; c < this.cells; c++) s += this.state[k * this.cells + c]!
      e += s * layerMm[k]!
    }
    return e * grid.pitchMm * grid.pitchMm * this.heatCapacityJPerMm3K
  }

  /** Energy (J) and dose energy (J) at a point, bilinear over the four nearest cells. */
  inject(xMm: number, yMm: number, eAbsJ: number, eDoseJ: number): void {
    const { grid, layerMm, injectFraction } = this.plan
    const { width, height, pitchMm } = grid
    const fx = (xMm - grid.originXMm) / pitchMm - 0.5
    const fy = (yMm - grid.originYMm) / pitchMm - 0.5
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const ax = fx - ix
    const ay = fy - iy
    const area = pitchMm * pitchMm
    for (let dy = 0; dy < 2; dy++) {
      const y = Math.min(height - 1, Math.max(0, iy + dy))
      const wy = dy ? ay : 1 - ay
      for (let dx = 0; dx < 2; dx++) {
        const x = Math.min(width - 1, Math.max(0, ix + dx))
        const w = (dx ? ax : 1 - ax) * wy
        const c = y * width + x
        for (let k = 0; k < layerMm.length; k++)
          this.fresh[k * this.cells + c]! += (w * eAbsJ * injectFraction[k]!) / (this.heatCapacityJPerMm3K * area * layerMm[k]!)
        this.doseAcc[c]! += (w * eDoseJ) / area
      }
    }
    this.injectedJ += eAbsJ
    this.live = true
    this.freshPending = true
  }

  /** Spread the heat injected since the last call laterally (injectSpreadCells2) and add it to the state. */
  land(): void {
    if (!this.freshPending) return
    const { width, height } = this.plan.grid
    const taps = gaussianTaps(this.plan.injectSpreadCells2)
    for (let k = 0; k < this.plan.layerMm.length; k++) {
      const layer = this.fresh.subarray(k * this.cells, (k + 1) * this.cells)
      lateralBlur(layer, layer, this.scratch, width, height, taps)
      const off = k * this.cells
      for (let c = 0; c < this.cells; c++) this.state[off + c]! += layer[c]!
      layer.fill(0)
    }
    this.freshPending = false
  }

  /** Bulk excess temperature from the top layer and accumulated dose, both bilinear (mirror / clamped edges). */
  gather(xMm: number, yMm: number): { bulkK: number; doseAcc: number } {
    const { grid } = this.plan
    const { width, height, pitchMm } = grid
    const top = this.state
    const fx = (xMm - grid.originXMm) / pitchMm - 0.5
    const fy = (yMm - grid.originYMm) / pitchMm - 0.5
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const ax = fx - ix
    const ay = fy - iy
    const x0 = mirrorIndex(ix, width)
    const x1 = mirrorIndex(ix + 1, width)
    const y0 = mirrorIndex(iy, height) * width
    const y1 = mirrorIndex(iy + 1, height) * width
    const t = (top[y0 + x0]! * (1 - ax) + top[y0 + x1]! * ax) * (1 - ay) + (top[y1 + x0]! * (1 - ax) + top[y1 + x1]! * ax) * ay
    const at = (x: number, y: number) => this.doseAcc[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]!
    const dose = (at(ix, iy) * (1 - ax) + at(ix + 1, iy) * ax) * (1 - ay) + (at(ix, iy + 1) * (1 - ax) + at(ix + 1, iy + 1) * ax) * ay
    return { bulkK: t, doseAcc: dose }
  }

  /** Record a gathered bulk temperature in the map (nearest cell). */
  recordBulk(xMm: number, yMm: number, bulkK: number): void {
    const { grid } = this.plan
    const x = Math.min(grid.width - 1, Math.max(0, Math.floor((xMm - grid.originXMm) / grid.pitchMm)))
    const y = Math.min(grid.height - 1, Math.max(0, Math.floor((yMm - grid.originYMm) / grid.pitchMm)))
    const c = y * grid.width + x
    if (bulkK > this.bulkK[c]!) this.bulkK[c] = bulkK
  }

  /** Let `dtS` pass; consecutive calls merge into one step at the next inject or gather. */
  advance(dtS: number): void {
    if (this.live) this.pendingS += dtS
  }

  /** Apply the pending diffusion: lateral Gaussian per layer (mirror edges), then implicit depth per column. */
  flush(): void {
    const dt = this.pendingS
    this.pendingS = 0
    if (dt <= 0) return
    const { grid, layerMm, alphaMm2PerS } = this.plan
    const { width, height } = grid
    const taps = diffusionTaps(alphaMm2PerS, dt, grid.pitchMm)
    for (let k = 0; k < layerMm.length; k++) {
      const layer = this.state.subarray(k * this.cells, (k + 1) * this.cells)
      lateralBlur(layer, layer, this.scratch, width, height, taps)
    }
    const solver = depthSolver(layerMm, alphaMm2PerS, dt)
    const col = new Float64Array(layerMm.length)
    for (let c = 0; c < this.cells; c++) {
      for (let k = 0; k < layerMm.length; k++) col[k] = this.state[k * this.cells + c]!
      depthStep(col, solver)
      for (let k = 0; k < layerMm.length; k++) this.state[k * this.cells + c] = col[k]!
    }
  }
}

/** Separable blur with mirror edges: src → tmp along X, tmp → dst along Y (dst may be src). */
function lateralBlur(src: Float32Array, dst: Float32Array, tmp: Float32Array, width: number, height: number, taps: Float32Array): void {
  const r = (taps.length - 1) / 2
  // Mirror lookups only within r of an edge; the interior reads directly.
  const pass = (from: Float32Array, to: Float32Array, along: number, across: number, step: number, stride: number) => {
    for (let j = 0; j < across; j++) {
      const row = j * stride
      for (let i = 0; i < along; i++) {
        let acc = 0
        if (i >= r && i < along - r) for (let t = -r; t <= r; t++) acc += from[row + (i + t) * step]! * taps[t + r]!
        else for (let t = -r; t <= r; t++) acc += from[row + mirrorIndex(i + t, along) * step]! * taps[t + r]!
        to[row + i * step] = acc
      }
    }
  }
  pass(src, tmp, width, height, 1, width)
  pass(tmp, dst, height, width, width, 1)
}

/**
 * Where sample time t falls in bin k, 0..1. The lagged bin is injected whole at
 * the bin start, but a sample late in its bin should see all of it and one
 * early in its bin almost none: the gather blends the states before and after
 * the injection by this fraction (contract thermal.ts).
 */
export function binFraction(tS: number, k: number, binS: number): number {
  return Math.min(1, Math.max(0, tS / binS - k))
}

/** Completes a gathered sample: absorption from the char level, dose weight from the bulk temperature. */
export function finishSample(
  material: MaterialProfile,
  thermal: PeakTemperatureModel,
  ramp: ResponseParams,
  energyJ: number,
  flash: number,
  bulkGain: number,
  bulkK: number,
  doseAcc: number,
): { eAbs: number; eDose: number } {
  const a = absorptionAt(material, thermal, thermal.absorptionAtFullChar === undefined ? 0 : rampT(ramp, doseAcc))
  const eAbs = energyJ * a
  return { eAbs, eDose: eAbs * (flash + (bulkK * bulkGain) / a) }
}

export interface CpuThermalRun extends ThermalResult {
  grid: CpuThermalGrid
  /** Per-sample bulk temperature (K above ambient) each sample gathered. */
  sampleBulkK: Float32Array
}

/** Grow a typed array to hold n, keeping its contents (1.5× headroom). */
function grown<T extends Float32Array | Uint32Array>(a: T, n: number, make: (n: number) => T): T {
  if (a.length >= n) return a
  const b = make(Math.max(n, Math.ceil(a.length * 1.5), 1024))
  b.set(a)
  return b
}

/**
 * What a run keeps to continue later (BURN-35): the plan, per-sample buffers
 * with headroom, bin starts, and the grid and statics memo as they were at
 * the start of the last bin, the first one new samples can land in.
 */
interface CpuResume {
  plan: ThermalPlan
  count: number
  storeVersion: number
  /** tS of the last sample covered, to check the store only grew. */
  lastT: number
  grid: CpuThermalGrid
  eAbs: Float32Array
  eDose: Float32Array
  sampleBulkK: Float32Array
  flash: Float32Array
  bulkGain: Float32Array
  binStart: Uint32Array
  /** Grid state at the start of bin plan.binCount − 1, before its diffusion. */
  lastBin: CpuGridSnapshot
  /** Statics memo just before that bin's first sample. */
  memo: StaticsMemo
}

/** The peakTemperature step on the CPU (Option B reference). */
export class CpuPeakTemperatureStep implements ThermalStep {
  readonly id: string
  private readonly resumes = new WeakMap<ThermalResult, CpuResume>()
  constructor(readonly options: ThermalPlanOptions = {}) {
    this.id = `peakTemperature/${options.pitchMm ?? ''}/${options.binS ?? ''}/${options.nearS ?? ''}`
  }

  run(store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning: ThermalPlanning = 'job'): CpuThermalRun {
    const thermal = peakTemperatureModel(material)
    if (!thermal) throw new Error('CpuPeakTemperatureStep: material has no peakTemperature thermal model')
    const plan = thermalPlanFor(store, thermal, this.options, planning)
    const n = store.count
    const r: CpuResume = {
      plan,
      count: 0,
      storeVersion: -1,
      lastT: -Infinity,
      grid: new CpuThermalGrid(plan, thermal.volumetricHeatCapacityJPerMm3K),
      eAbs: new Float32Array(n),
      eDose: new Float32Array(n),
      sampleBulkK: new Float32Array(n),
      flash: new Float32Array(n),
      bulkGain: new Float32Array(n),
      binStart: new Uint32Array(plan.binCount + 1),
      lastBin: null!,
      memo: freshStaticsMemo(),
    }
    return this.advance(r, store, machine, material, kernel, thermal, 0)
  }

  extend(prev: ThermalResult, store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning: ThermalPlanning = 'job'): CpuThermalRun | null {
    const r = this.resumes.get(prev)
    const thermal = peakTemperatureModel(material)
    if (!r || !thermal || store.count < r.count || r.count === 0) return null
    if (store.tS[r.count - 1] !== r.lastT || store.version === r.storeVersion) return null
    const plan = thermalPlanFor(store, thermal, this.options, planning)
    if (!sameThermalPlan(plan, r.plan)) return null
    // Superseded: prev's buffers are shared prefixes, its grid is stepped on.
    this.resumes.delete(prev)
    const from = r.plan.binCount - 1
    r.plan = plan
    r.grid.restore(r.lastBin)
    const n = store.count
    r.eAbs = grown(r.eAbs, n, (k) => new Float32Array(k))
    r.eDose = grown(r.eDose, n, (k) => new Float32Array(k))
    r.sampleBulkK = grown(r.sampleBulkK, n, (k) => new Float32Array(k))
    r.flash = grown(r.flash, n, (k) => new Float32Array(k))
    r.bulkGain = grown(r.bulkGain, n, (k) => new Float32Array(k))
    r.binStart = grown(r.binStart, plan.binCount + 1, (k) => new Uint32Array(k))
    return this.advance(r, store, machine, material, kernel, thermal, from)
  }

  /** Step bins [fromBin, binCount + lagBins) of r.plan; r holds every earlier sample's result and the grid at fromBin's start. */
  private advance(
    r: CpuResume,
    store: SampleStore,
    machine: MachineProfile,
    material: MaterialProfile,
    kernel: KernelSigma,
    thermal: PeakTemperatureModel,
    fromBin: number,
  ): CpuThermalRun {
    const { plan, grid, eAbs, eDose, sampleBulkK, flash, bulkGain, binStart } = r
    const n = store.count
    const table = cachedFlashTable(machine, kernel, thermal, plan.nearS)
    const ramp = responseParams(material)
    const last = plan.binCount - 1
    fillBinStarts(store, plan, binStart, fromBin, fromBin === 0 ? 0 : binStart[fromBin]!)
    // Statics from fromBin's first sample, with the memo kept at the last bin's start for the next resume.
    staticsRange(store, binStart[fromBin]!, binStart[last]!, table, material, thermal, r.memo, flash, bulkGain)
    const memoAtLast = { ...r.memo }
    staticsRange(store, binStart[last]!, n, table, material, thermal, r.memo, flash, bulkGain)
    r.memo = memoAtLast
    const { xye } = store
    let widest = 0
    for (let k = fromBin; k < plan.binCount; k++) widest = Math.max(widest, binStart[k + 1]! - binStart[k]!)
    const preDose = new Float32Array(widest)
    for (let k = fromBin; k < plan.binCount + plan.lagBins; k++) {
      if (k === last) r.lastBin = grid.snapshot()
      const j = k - plan.lagBins
      const injFrom = j >= 0 && j < plan.binCount ? binStart[j]! : 0
      const injTo = j >= 0 && j < plan.binCount ? binStart[j + 1]! : 0
      const gatFrom = k < plan.binCount ? binStart[k]! : 0
      const gatTo = k < plan.binCount ? binStart[k + 1]! : 0
      if (injTo > injFrom || gatTo > gatFrom) grid.flush()
      // Before the lagged bin lands, for the time blend below.
      for (let i = gatFrom; i < gatTo; i++) {
        const g = grid.gather(xye[i * 3]!, xye[i * 3 + 1]!)
        sampleBulkK[i] = g.bulkK
        preDose[i - gatFrom] = g.doseAcc
      }
      for (let i = injFrom; i < injTo; i++) grid.inject(xye[i * 3]!, xye[i * 3 + 1]!, eAbs[i]!, eDose[i]!)
      grid.land()
      for (let i = gatFrom; i < gatTo; i++) {
        const x = xye[i * 3]!
        const y = xye[i * 3 + 1]!
        const g = grid.gather(x, y)
        const f = binFraction(store.tS[i]!, k, plan.binS)
        const bulk = sampleBulkK[i]! + (g.bulkK - sampleBulkK[i]!) * f
        const dose = preDose[i - gatFrom]! + (g.doseAcc - preDose[i - gatFrom]!) * f
        const out = finishSample(material, thermal, ramp, xye[i * 3 + 2]!, flash[i]!, bulkGain[i]!, bulk, dose)
        eAbs[i] = out.eAbs
        eDose[i] = out.eDose
        sampleBulkK[i] = bulk
        grid.recordBulk(x, y, bulk)
      }
      grid.advance(plan.binS)
    }
    grid.flush()
    r.count = n
    r.storeVersion = store.version
    r.lastT = n ? store.tS[n - 1]! : -Infinity
    const result: CpuThermalRun = {
      count: n,
      storeVersion: store.version,
      eAbs: eAbs.subarray(0, n),
      eDose: eDose.subarray(0, n),
      bulkK: grid.bulkK,
      plan,
      ambientK: thermal.ambientK,
      flashK: flashKPerJPerMm2(material, thermal),
      grid,
      sampleBulkK: sampleBulkK.subarray(0, n),
    }
    if (n > 0) this.resumes.set(result, r)
    return result
  }
}

/** Bulk temperature (K, absolute) at a point from a result's map; ambient outside it or without a map. */
export function bulkAt(result: ThermalResult, xMm: number, yMm: number): number {
  const { bulkK, plan } = result
  if (!bulkK || !plan) return result.ambientK
  const g = plan.grid
  const x = Math.floor((xMm - g.originXMm) / g.pitchMm)
  const y = Math.floor((yMm - g.originYMm) / g.pitchMm)
  if (x < 0 || y < 0 || x >= g.width || y >= g.height) return result.ambientK
  return result.ambientK + bulkK[y * g.width + x]!
}

interface CacheEntry {
  key: unknown[]
  result: ThermalResult
  /** store.missingSequences.length when computed: a new gap means batches came out of order. */
  missing: number
}

const resultCache = new WeakMap<SampleStore, CacheEntry>()

const cacheKey = (store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, stepId: string, planning: ThermalPlanning): unknown[] => [
  store.version,
  machine,
  material,
  kernel.sigmaUMm,
  kernel.sigmaVMm,
  kernel.angleDeg,
  stepId,
  planning,
]

/** Seed the cache with a result computed elsewhere (the GPU step), so the readout reuses it. */
export function cacheThermal(
  store: SampleStore,
  machine: MachineProfile,
  material: MaterialProfile,
  kernel: KernelSigma,
  stepId: string,
  result: ThermalResult,
  planning: ThermalPlanning = 'job',
): void {
  resultCache.set(store, { key: cacheKey(store, machine, material, kernel, stepId, planning), result, missing: store.missingSequences.length })
}

/** How the last thermalFor call got its result (bench and tests): cached, continued (extend), or a full run. */
export let lastThermalPath: 'cached' | 'extended' | 'full' | null = null

/**
 * The thermal result for a store and material, cached per store version, so
 * every tile, the coarse scrub and the hover readout share one run. When only
 * the store changed (a live job streamed more samples) a step with `extend`
 * continues the cached result over the new bins instead (BURN-35); it falls
 * back to a full run whenever the plan, machine, material, kernel or planning
 * changed or a batch went missing.
 */
export function thermalFor(
  store: SampleStore,
  machine: MachineProfile,
  material: MaterialProfile,
  kernel: KernelSigma,
  step: ThermalStep = defaultThermalStep,
  planning: ThermalPlanning = 'job',
): ThermalResult | null {
  // A material without a thermal model drives the response from fluence, whatever the step.
  if (!peakTemperatureModel(material)) return null
  const key = cacheKey(store, machine, material, kernel, step.id, planning)
  const hit = resultCache.get(store)
  const missing = store.missingSequences.length
  if (hit && !hit.result.lost && hit.key.length === key.length) {
    if (hit.key.every((v, i) => v === key[i])) {
      lastThermalPath = 'cached'
      return hit.result
    }
    // Same everything but the store version, no new gaps: continue it.
    if (step.extend && hit.missing === missing && hit.result.count < store.count && hit.key.every((v, i) => i === 0 || v === key[i])) {
      const result = step.extend(hit.result, store, machine, material, kernel, planning)
      if (result) {
        resultCache.set(store, { key, result, missing })
        lastThermalPath = 'extended'
        return result
      }
    }
  }
  const result = step.run(store, machine, material, kernel, planning)
  resultCache.set(store, { key, result, missing })
  lastThermalPath = 'full'
  return result
}

export const defaultThermalStep: ThermalStep = new CpuPeakTemperatureStep()

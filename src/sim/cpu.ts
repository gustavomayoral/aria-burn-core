// SPDX-License-Identifier: MIT
// CPU reference pipeline: deposit → two-pass blur → response, tiled per the
// contract. With a thermal model (COD-258) the thermal step runs first and a
// second dose buffer goes through the same deposit and blur. It is the oracle the WebGL2 path is checked against, the headless
// path for Vitest, and the fallback when EXT_float_blend is missing.

import type { CellRect, GridSpec, SimOutputs } from '../contract/index.ts'
import type { Kernel1D, SeparableKernel, SkewTaps } from './kernel.ts'
import { coarseSetup, subGrid, type SimSetup } from './job.ts'
import { respond } from './response.ts'
import type { SampleStore } from './sample-store.ts'
import { thermalFor, type ThermalResult } from './thermal.ts'

export interface DepositBuffer {
  data: Float32Array
  /** Σ E·absorption of the samples deposited (J), clipped or not. */
  expectedEnergyJ: number
  /** Energy whose bilinear weight fell outside the rect (J). */
  clippedEnergyJ: number
}

/**
 * Deposit the first `n` samples into `rect` of the job grid as bilinear points:
 * each sample adds w·E·absorption / pitch² to the four nearest cell centres,
 * keeping only the weights that land inside the rect. With `energies` (a
 * thermal step's per-sample eAbs or eDose, J) those replace E·absorption.
 */
export function depositCpu(
  store: SampleStore,
  n: number,
  grid: GridSpec,
  rect: CellRect,
  absorption: number,
  energies: Float32Array | null = null,
): DepositBuffer {
  const { width, height } = rect
  const data = new Float32Array(width * height)
  const inv = 1 / grid.pitchMm
  const scale = absorption * inv * inv
  const xye = store.xye
  let expected = 0
  let clipped = 0
  for (let s = 0; s < n; s++) {
    const e = energies ? energies[s]! : xye[s * 3 + 2]! * absorption
    expected += e
    // Job-grid cell coordinates relative to cell centres, then shifted to the rect by whole cells.
    const fx = (xye[s * 3]! - grid.originXMm) * inv - 0.5
    const fy = (xye[s * 3 + 1]! - grid.originYMm) * inv - 0.5
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const ax = fx - ix
    const ay = fy - iy
    const x0 = ix - rect.x
    const y0 = iy - rect.y
    const f = energies ? energies[s]! * inv * inv : xye[s * 3 + 2]! * scale
    let kept = 0
    for (let dy = 0; dy < 2; dy++) {
      const y = y0 + dy
      if (y < 0 || y >= height) continue
      const wy = dy ? ay : 1 - ay
      for (let dx = 0; dx < 2; dx++) {
        const x = x0 + dx
        if (x < 0 || x >= width) continue
        const w = (dx ? ax : 1 - ax) * wy
        data[y * width + x]! += w * f
        kept += w
      }
    }
    clipped += (1 - kept) * e
  }
  return { data, expectedEnergyJ: expected, clippedEnergyJ: clipped }
}

/** One 1D pass with zero padding outside the buffer. */
function blurPass(src: Float32Array, width: number, height: number, k: Kernel1D, horizontal: boolean): Float32Array {
  const out = new Float32Array(src.length)
  const { radius, weights } = k
  const along = horizontal ? width : height
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const c = horizontal ? i : j
      const lo = Math.max(-radius, -c)
      const hi = Math.min(radius, along - 1 - c)
      let acc = 0
      if (horizontal) {
        const row = j * width + i
        for (let t = lo; t <= hi; t++) acc += src[row + t]! * weights[t + radius]!
      } else {
        for (let t = lo; t <= hi; t++) acc += src[(j + t) * width + i]! * weights[t + radius]!
      }
      out[j * width + i] = acc
    }
  }
  return out
}

/** The sheared Y pass of a rotated kernel: row offset t reads x + offset[t] and the cell after it. */
function skewPass(src: Float32Array, width: number, height: number, k: Kernel1D, skew: SkewTaps): Float32Array {
  const out = new Float32Array(src.length)
  const { radius } = k
  const { offset, w0, w1 } = skew
  for (let j = 0; j < height; j++) {
    const lo = Math.max(-radius, -j)
    const hi = Math.min(radius, height - 1 - j)
    for (let i = 0; i < width; i++) {
      let acc = 0
      for (let t = lo; t <= hi; t++) {
        const tap = t + radius
        const x = i + offset[tap]!
        const row = (j + t) * width
        if (x >= 0 && x < width) acc += src[row + x]! * w0[tap]!
        if (x + 1 >= 0 && x + 1 < width) acc += src[row + x + 1]! * w1[tap]!
      }
      out[j * width + i] = acc
    }
  }
  return out
}

export function blurCpu(
  data: Float32Array,
  width: number,
  height: number,
  kernel: SeparableKernel,
): { afterH: Float32Array; afterV: Float32Array } {
  const afterH = blurPass(data, width, height, kernel.x, true)
  const afterV = kernel.skew ? skewPass(afterH, width, height, kernel.y, kernel.skew) : blurPass(afterH, width, height, kernel.y, false)
  return { afterH, afterV }
}

/** Σ cell · pitch² over a rect of a buffer (J), f64. */
export function rectEnergyJ(data: Float32Array, stride: number, rect: CellRect, pitchMm: number): number {
  let sum = 0
  for (let y = rect.y; y < rect.y + rect.height; y++)
    for (let x = rect.x; x < rect.x + rect.width; x++) sum += data[y * stride + x]!
  return sum * pitchMm * pitchMm
}

/** Conservation bookkeeping per stage, summed over tile cores (COD-252 table). */
export interface StageEnergy {
  expectedJ: number
  depositJ: number
  blurHJ: number
  blurVJ: number
  clippedJ: number
}

export interface CpuTileResult {
  core: CellRect
  outputs: SimOutputs
}

export interface CpuRun {
  setup: SimSetup
  sampleCount: number
  tiles: CpuTileResult[]
  energy: StageEnergy
  /** The thermal step's result, or null without a thermal model. */
  thermal: ThermalResult | null
}

export interface CpuRunOptions {
  timeCutoffS?: number
}

/** Full-resolution run over every tile of the setup's plan. */
export function simulateCpu(store: SampleStore, setup: SimSetup, options: CpuRunOptions = {}): CpuRun {
  const n = store.countUntil(options.timeCutoffS ?? Infinity)
  const { grid, plan, material, separable } = setup
  const thermal = thermalFor(store, setup.machine, material, setup.thermalKernel, setup.thermalStep)
  const energy: StageEnergy = { expectedJ: 0, depositJ: 0, blurHJ: 0, blurVJ: 0, clippedJ: 0 }
  const tiles: CpuTileResult[] = []
  for (const tile of plan.tiles) {
    const { padded, core } = tile
    const dep = depositCpu(store, n, grid, padded, material.absorption, thermal?.eAbs)
    const { afterH, afterV } = blurCpu(dep.data, padded.width, padded.height, separable)
    const doseV = thermal ? blurCpu(depositCpu(store, n, grid, padded, material.absorption, thermal.eDose).data, padded.width, padded.height, separable).afterV : null
    const local = { x: core.x - padded.x, y: core.y - padded.y, width: core.width, height: core.height }
    energy.depositJ += rectEnergyJ(dep.data, padded.width, local, grid.pitchMm)
    energy.blurHJ += rectEnergyJ(afterH, padded.width, local, grid.pitchMm)
    energy.blurVJ += rectEnergyJ(afterV, padded.width, local, grid.pitchMm)
    if (tiles.length === 0) energy.expectedJ = dep.expectedEnergyJ
    const spec0 = subGrid(grid, padded)
    const img = respond(
      material,
      afterV,
      padded.width,
      padded.height,
      local,
      thermal && doseV ? { dose: doseV, result: thermal, originXMm: spec0.originXMm, originYMm: spec0.originYMm, pitchMm: grid.pitchMm } : null,
    )
    const coreFluence = new Float32Array(core.width * core.height)
    for (let y = 0; y < core.height; y++)
      coreFluence.set(afterV.subarray((local.y + y) * padded.width + local.x, (local.y + y) * padded.width + local.x + core.width), y * core.width)
    const spec = subGrid(grid, core)
    tiles.push({
      core,
      outputs: {
        ...spec,
        fluence: { ...spec, data: coreFluence },
        color: img.color,
        depthMm: img.depthMm,
        verdict: img.verdict,
        dose: img.dose,
        peakTemperatureK: img.peakTemperatureK,
        bulkTemperatureK: img.bulkTemperatureK,
      },
    })
  }
  // Clipped energy is meaningful on the whole job grid only (tiles clip by design).
  energy.clippedJ = energy.expectedJ - energy.depositJ
  return { setup, sampleCount: n, tiles, energy, thermal }
}

/** Coarse scrub preview: same function on the coarse grid with the widened kernel. */
export function simulateCoarseCpu(store: SampleStore, full: SimSetup, timeCutoffS: number): CpuRun {
  return simulateCpu(store, coarseSetup(full), { timeCutoffS })
}

/** Stitch tile cores into job-sized images (small jobs and tests only). */
export function stitch(run: CpuRun): SimOutputs {
  const { grid } = run.setup
  const w = grid.width
  const fluence = new Float32Array(w * grid.height)
  const color = new Uint8ClampedArray(w * grid.height * 4)
  const depthMm = new Float32Array(w * grid.height)
  const verdict = new Uint8Array(w * grid.height)
  const thermal = run.thermal !== null
  const dose = thermal ? new Float32Array(w * grid.height) : null
  const peak = thermal ? new Float32Array(w * grid.height) : null
  const bulk = thermal ? new Float32Array(w * grid.height) : null
  for (const { core, outputs } of run.tiles) {
    for (let y = 0; y < core.height; y++) {
      const dst = (core.y + y) * w + core.x
      const src = y * core.width
      fluence.set(outputs.fluence.data.subarray(src, src + core.width), dst)
      depthMm.set(outputs.depthMm.subarray(src, src + core.width), dst)
      verdict.set(outputs.verdict.subarray(src, src + core.width), dst)
      color.set(outputs.color.subarray(src * 4, (src + core.width) * 4), dst * 4)
      dose?.set(outputs.dose!.subarray(src, src + core.width), dst)
      peak?.set(outputs.peakTemperatureK!.subarray(src, src + core.width), dst)
      bulk?.set(outputs.bulkTemperatureK!.subarray(src, src + core.width), dst)
    }
  }
  return { ...grid, fluence: { ...grid, data: fluence }, color, depthMm, verdict, dose, peakTemperatureK: peak, bulkTemperatureK: bulk }
}

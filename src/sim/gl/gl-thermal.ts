// SPDX-License-Identifier: MIT
// WebGL2 port of the peakTemperature thermal step (COD-258): the same bin loop
// as CpuPeakTemperatureStep, with the thermal grid, the per-sample energies
// and every gather and injection on the GPU. Per active bin it runs two
// fullscreen passes over the thermal grid (lateral X, which also lands the
// previous bin's fresh heat; lateral Y fused with the implicit depth step),
// three point draws over the bin's samples (gather, inject the lagged bin into
// a fresh-heat texture, gather again) and two lateral passes that spread the
// fresh heat, scissored to the few cells around the injected samples.
//
// The samples and their static attributes reach the GPU through a bounded
// vertex window (vertex-window.ts, BURN-38), refilled from the store as the
// bin loop moves on, instead of the whole sample buffer beside a whole-job
// statics buffer.
//
// The per-sample (eAbs, eDose) texture stays on the GPU for the fine deposit
// (GlSim looks samples up by store index); the CPU arrays are read back only
// when something asks for them (the hover readout). The bulk map is built on
// the GPU with one MAX-blended point draw and read back (it is small).

import {
  depthSolver,
  diffusionTaps,
  type DepthSolver,
  flashKPerJPerMm2,
  gaussianTaps,
  type KernelSigma,
  type MachineProfile,
  type MaterialProfile,
} from '../../contract/index.ts'
import { responseParams } from '../response.ts'
import type { SampleStore } from '../sample-store.ts'
import {
  binFraction,
  cachedFlashTable,
  defaultThermalStep,
  fillBinStarts,
  freshStaticsMemo,
  peakTemperatureModel,
  staticsRange,
  thermalPlanFor,
  type StaticsMemo,
  type ThermalPlanning,
  type ThermalResult,
  type ThermalStep,
} from '../thermal.ts'
import { sameThermalPlan, type PeakTemperatureModel, type ThermalPlan } from '../../contract/index.ts'
import { GlContextLostError, Program, deleteTexture, framebuffer, target, texture, type Target } from './gl-util.ts'
import { FULLSCREEN_VS } from './shaders.ts'
import { VertexWindow } from './vertex-window.ts'
import {
  PER_SAMPLE_WIDTH,
  THERMAL_BULK_FS,
  THERMAL_BULK_VS,
  THERMAL_DIFFUSE_FS,
  THERMAL_GATHER_FS,
  THERMAL_GATHER_VS,
  THERMAL_INJECT_FS,
  THERMAL_INJECT_VS,
} from './thermal-shaders.ts'

/** A GPU thermal result: the CPU arrays plus the per-sample texture GlSim deposits from. */
export interface GlThermalResult extends ThermalResult {
  /** RG32F, PER_SAMPLE_WIDTH wide: (eAbs, eDose) of sample i at texel (i % width, i / width). */
  perSample: WebGLTexture
  /** R32F bulk map on the thermal grid (same data as bulkK). */
  bulk: WebGLTexture
  /** Wall time of the whole step (ms), and its parts: CPU statics, GPU bin loop and bulk map (synced), bulk-map readback. */
  gpuMs: number
  timing: { staticsMs: number; loopMs: number; readbackMs: number }
  /** Active bins stepped by this call (only the new ones when extended). */
  activeBins: number
  /** True when this result continued the previous one over new samples (BURN-35). */
  extended: boolean
}

type Rect = [x0: number, y0: number, x1: number, y1: number]

/** Spare capacity for per-sample buffers of a live run (BURN-35): regrowing them re-uploads everything. */
const LIVE_HEADROOM = 1.25

/** Floats per sample in the vertex window: x, y, energy, then flash factor, bulk gain, bin fraction. */
const CHUNK_STRIDE = 6

/**
 * The GPU step's state between calls (BURN-35): the textures of the last run
 * and what it needs to continue over appended samples — bin starts, statics,
 * and the grid as it was at the start of the last bin (snapshot targets plus
 * the loop's scalars).
 */
interface GlResume {
  plan: ThermalPlan
  material: MaterialProfile
  thermal: PeakTemperatureModel
  count: number
  storeVersion: number
  lastT: number
  binStart: Uint32Array
  memo: StaticsMemo
  flash: Float32Array
  bulkGain: Float32Array
  /** Static attributes per sample (flash, bulk gain, bin fraction), uploaded with the samples a chunk at a time. */
  statics: Float32Array
  s0: Target
  s1: Target
  fresh: Target
  freshTmp: Target
  freshSpread: Target
  dose: Target
  injectFbo: WebGLFramebuffer
  perSample: Target
  perSampleRows: number
  pre: Target
  preRows: number
  bulk: Target
  /** Loop state now, and at the start of the last bin (with the snapshot textures). */
  pending: number
  live: boolean
  freshRect: Rect | null
  snap: { s0: Target; dose: Target; freshSpread: Target; pending: number; live: boolean; freshRect: Rect | null }
}

/** Read an R32F attachment (RGBA readback is the format every implementation must support). */
function readR32F(gl: WebGL2RenderingContext, fbo: WebGLFramebuffer, w: number, h: number): Float32Array {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.readBuffer(gl.COLOR_ATTACHMENT0)
  const raw = new Float32Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw)
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = raw[i * 4]!
  return out
}

export class GlPeakTemperatureStep implements ThermalStep {
  /** Same model as the CPU reference, so they share the thermalFor cache. */
  readonly id = defaultThermalStep.id
  private readonly diffuse: Program
  private readonly inject: Program
  private readonly gather: Program
  private readonly vao: WebGLVertexArrayObject
  private readonly emptyVao: WebGLVertexArrayObject
  /** Samples on the GPU a window at a time: interleaved (x, y, E, flash, bulk gain, bin fraction) by store index. */
  private readonly window: VertexWindow
  /** Bumped whenever the statics behind the window change (every advance). */
  private windowVersion = 0
  private readonly tapTextures = new Map<string, WebGLTexture>()
  private owned: WebGLTexture[] = []
  private ownedFbos: WebGLFramebuffer[] = []
  /** The last run's result while its textures are alive. */
  current: GlThermalResult | null = null
  /** Reads the current result's per-sample energies back (once), so they outlive its textures. */
  private materialize: (() => unknown) | null = null
  private readonly bulkProgram: Program

  constructor(readonly gl: WebGL2RenderingContext) {
    this.diffuse = new Program(gl, FULLSCREEN_VS, THERMAL_DIFFUSE_FS)
    this.inject = new Program(gl, THERMAL_INJECT_VS, THERMAL_INJECT_FS)
    this.gather = new Program(gl, THERMAL_GATHER_VS, THERMAL_GATHER_FS)
    this.bulkProgram = new Program(gl, THERMAL_BULK_VS, THERMAL_BULK_FS)
    this.vao = gl.createVertexArray()!
    this.emptyVao = gl.createVertexArray()!
    this.window = new VertexWindow(gl, CHUNK_STRIDE * 4)
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.window.buffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, CHUNK_STRIDE * 4, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, CHUNK_STRIDE * 4, 12)
    gl.bindVertexArray(null)
  }

  /** Free the textures of the last run (the per-sample texture of its result included). */
  release(): void {
    // The result may still be cached for the hover readout: keep its energies on the CPU.
    this.materialize?.()
    this.materialize = null
    for (const t of this.owned) deleteTexture(this.gl, t)
    for (const f of this.ownedFbos) this.gl.deleteFramebuffer(f)
    this.owned = []
    this.ownedFbos = []
    this.current = null
    this.resume = null
    this.window.release()
  }

  /**
   * Hold store indices [lo, hi) in the vertex window (refilling it from lo when
   * they aren't all there) and return the store index of its first sample.
   */
  private chunk(store: SampleStore, statics: Float32Array, lo: number, hi: number): number {
    return this.window.hold(this, this.windowVersion, lo, hi, store.count, (dst, from, to) => {
      const out = new Float32Array(dst, 0, (to - from) * CHUNK_STRIDE)
      const { xye } = store
      for (let i = from, o = 0; i < to; i++, o += CHUNK_STRIDE) {
        out[o] = xye[i * 3]!
        out[o + 1] = xye[i * 3 + 1]!
        out[o + 2] = xye[i * 3 + 2]!
        out[o + 3] = statics[i * 3]!
        out[o + 4] = statics[i * 3 + 1]!
        out[o + 5] = statics[i * 3 + 2]!
      }
    })
  }

  private taps(alpha: number, dt: number, pitch: number): { tex: WebGLTexture; radius: number } {
    return this.tapTexture(diffusionTaps(alpha, dt, pitch))
  }

  private tapTexture(w: Float32Array): { tex: WebGLTexture; radius: number } {
    const key = w.join()
    let tex = this.tapTextures.get(key)
    if (!tex) {
      const gl = this.gl
      tex = texture(gl, gl.R32F, w.length, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w.length, 1, gl.RED, gl.FLOAT, w)
      if (this.tapTextures.size > 64) {
        for (const t of this.tapTextures.values()) deleteTexture(gl, t)
        this.tapTextures.clear()
      }
      this.tapTextures.set(key, tex)
    }
    return { tex, radius: (w.length - 1) / 2 }
  }

  /** Continue-from state of `current` (BURN-35); dropped with its textures. */
  private resume: GlResume | null = null

  run(store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning: ThermalPlanning = 'job'): GlThermalResult {
    const thermal = peakTemperatureModel(material)
    if (!thermal) throw new Error('GlPeakTemperatureStep: material has no peakTemperature thermal model')
    const gl = this.gl
    const t0 = performance.now()
    this.release()
    const plan = thermalPlanFor(store, thermal, {}, planning)
    const n = store.count
    const { width: W, height: H } = plan.grid
    const s0 = this.ownTarget(gl.RGBA32F, W, H)
    const s1 = this.ownTarget(gl.RGBA32F, W, H)
    const fresh = this.ownTarget(gl.RGBA32F, W, H)
    const freshTmp = this.ownTarget(gl.RGBA32F, W, H)
    const freshSpread = this.ownTarget(gl.RGBA32F, W, H)
    const dose = this.ownTarget(gl.R32F, W, H)
    const injectFbo = framebuffer(gl, fresh.tex, dose.tex)
    this.ownedFbos.push(injectFbo)
    for (const fbo of [s0.fbo, s1.fbo, injectFbo]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    // A live job keeps growing: leave room so the next extends append in place instead of re-uploading.
    const cap = planning === 'live' ? Math.ceil(n * LIVE_HEADROOM) : n
    const perSampleRows = Math.max(1, Math.ceil(cap / PER_SAMPLE_WIDTH))
    const bulk = this.ownTarget(gl.R32F, W, H)
    gl.bindFramebuffer(gl.FRAMEBUFFER, bulk.fbo)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const r: GlResume = {
      plan,
      material,
      thermal,
      count: 0,
      storeVersion: -1,
      lastT: -Infinity,
      binStart: new Uint32Array(plan.binCount + 1),
      memo: freshStaticsMemo(),
      flash: new Float32Array(cap),
      bulkGain: new Float32Array(cap),
      statics: new Float32Array(cap * 3),
      s0,
      s1,
      fresh,
      freshTmp,
      freshSpread,
      dose,
      injectFbo,
      perSample: this.ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, perSampleRows),
      perSampleRows,
      pre: this.ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, 1),
      preRows: 1,
      bulk,
      pending: 0,
      live: false,
      freshRect: null,
      snap: {
        s0: this.ownTarget(gl.RGBA32F, W, H),
        dose: this.ownTarget(gl.R32F, W, H),
        freshSpread: this.ownTarget(gl.RGBA32F, W, H),
        pending: 0,
        live: false,
        freshRect: null,
      },
    }
    return this.advance(r, store, machine, kernel, 0, t0, false)
  }

  extend(prev: ThermalResult, store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma, planning: ThermalPlanning = 'job'): GlThermalResult | null {
    const r = this.resume
    const gl = this.gl
    if (!r || prev !== this.current || prev.lost || gl.isContextLost()) return null
    if (r.material !== material || store.count <= r.count || r.count === 0 || store.tS[r.count - 1] !== r.lastT) return null
    const t0 = performance.now()
    const plan = thermalPlanFor(store, r.thermal, {}, planning)
    if (!sameThermalPlan(plan, r.plan)) return null
    const from = r.plan.binCount - 1
    r.plan = plan
    // Back to the start of the last bin: the first one new samples can land in.
    this.copy(r.snap.s0, r.s0)
    this.copy(r.snap.dose, r.dose)
    this.copy(r.snap.freshSpread, r.freshSpread)
    r.pending = r.snap.pending
    r.live = r.snap.live
    r.freshRect = r.snap.freshRect
    const n = store.count
    const grow = (a: Float32Array, k: number) => {
      if (a.length >= k) return a
      const b = new Float32Array(Math.max(k, Math.ceil(a.length * LIVE_HEADROOM)))
      b.set(a)
      return b
    }
    r.flash = grow(r.flash, n)
    r.bulkGain = grow(r.bulkGain, n)
    r.statics = grow(r.statics, n * 3)
    if (r.binStart.length < plan.binCount + 1) {
      const b = new Uint32Array(Math.max(plan.binCount + 1, Math.ceil(r.binStart.length * 1.5)))
      b.set(r.binStart)
      r.binStart = b
    }
    if (n > r.perSampleRows * PER_SAMPLE_WIDTH) {
      // Grow the per-sample texture with headroom, keeping what it holds.
      const rows = Math.max(Math.ceil(n / PER_SAMPLE_WIDTH), Math.ceil(r.perSampleRows * LIVE_HEADROOM))
      const next = this.ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, rows)
      this.copy(r.perSample, next, PER_SAMPLE_WIDTH, r.perSampleRows)
      this.disown(r.perSample)
      r.perSample = next
      r.perSampleRows = rows
    }
    // The previous result's per-sample data may be gone (grown) and is superseded either way.
    this.materialize = null
    return this.advance(r, store, machine, kernel, from, t0, true)
  }

  private ownTarget(internal: number, w: number, h: number): Target {
    const t = target(this.gl, internal, w, h)
    this.owned.push(t.tex)
    this.ownedFbos.push(t.fbo)
    return t
  }

  private disown(t: Target): void {
    deleteTexture(this.gl, t.tex)
    this.gl.deleteFramebuffer(t.fbo)
    this.owned = this.owned.filter((x) => x !== t.tex)
    this.ownedFbos = this.ownedFbos.filter((x) => x !== t.fbo)
  }

  /** Copy src's first w × h texels into dst (same format). */
  private copy(src: Target, dst: Target, w?: number, h?: number): void {
    const gl = this.gl
    const r = this.resume
    const W = w ?? r!.plan.grid.width
    const H = h ?? r!.plan.grid.height
    gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo)
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
  }

  /**
   * Step bins [fromBin, binCount + lagBins) of r.plan on the GPU, with every
   * earlier sample's result in r.perSample and the grid at fromBin's start,
   * then add the new samples to the bulk map and build the result.
   */
  private advance(r: GlResume, store: SampleStore, machine: MachineProfile, kernel: KernelSigma, fromBin: number, t0: number, extended: boolean): GlThermalResult {
    const gl = this.gl
    this.resume = r
    const { plan, material, thermal, binStart } = r
    const n = store.count
    const { width: W, height: H, pitchMm } = plan.grid
    const last = plan.binCount - 1
    const table = cachedFlashTable(machine, kernel, thermal, plan.nearS)
    fillBinStarts(store, plan, binStart, fromBin, fromBin === 0 ? 0 : binStart[fromBin]!)
    const first = binStart[fromBin]!
    staticsRange(store, first, binStart[last]!, table, material, thermal, r.memo, r.flash, r.bulkGain)
    const memoAtLast = { ...r.memo }
    staticsRange(store, binStart[last]!, n, table, material, thermal, r.memo, r.flash, r.bulkGain)
    r.memo = memoAtLast
    // Static per-sample attributes from `first` on: flash factor, bulk gain, bin fraction.
    const statics = r.statics
    for (let k = fromBin; k < plan.binCount; k++)
      for (let i = binStart[k]!; i < binStart[k + 1]!; i++) {
        statics[i * 3] = r.flash[i]!
        statics[i * 3 + 1] = r.bulkGain[i]!
        statics[i * 3 + 2] = binFraction(store.tS[i]!, k, plan.binS)
      }
    const t1 = performance.now()
    // Statics from `first` on just changed: what the window holds is stale.
    this.windowVersion++

    let widest = 1
    for (let k = fromBin; k < plan.binCount; k++) widest = Math.max(widest, binStart[k + 1]! - binStart[k]!)
    const preRows = Math.ceil(widest / PER_SAMPLE_WIDTH)
    if (preRows > r.preRows) {
      this.disown(r.pre)
      r.pre = this.ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, preRows)
      r.preRows = preRows
    }
    const { s0, s1, fresh, freshTmp, freshSpread, dose, injectFbo, perSample, pre } = r
    const rows = r.perSampleRows

    const area = pitchMm * pitchMm
    const cv = thermal.volumetricHeatCapacityJPerMm3K
    const layerScale = plan.layerMm.map((d, k) => plan.injectFraction[k]! / (cv * area * d))
    const ramp = responseParams(material)
    const feedback = thermal.absorptionAtFullChar !== undefined
    const spreadTaps = this.tapTexture(gaussianTaps(plan.injectSpreadCells2))
    const gridUniforms = (p: Program) =>
      p
        .f('u_origin', plan.grid.originXMm, plan.grid.originYMm)
        .f('u_invPitch', 1 / pitchMm)
        .i('u_gridSize', W, H)

    /** One lateral pass of the diffuse program; see THERMAL_DIFFUSE_FS for the mask and add rects. */
    const lateral = (
      src: WebGLTexture,
      dst: Target,
      taps: { tex: WebGLTexture; radius: number },
      dir: [number, number],
      opts: { depth?: DepthSolver; mask?: Rect; add?: { tex: WebGLTexture; rect: Rect } },
    ) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, taps.tex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, opts.add?.tex ?? null)
      const p = this.diffuse
        .use()
        .i('u_src', 0)
        .i('u_taps', 1)
        .i('u_add', 2)
        .i('u_radius', taps.radius)
        .i('u_dir', ...dir)
        .i('u_size', W, H)
        .i('u_depth', opts.depth ? 1 : 0)
        .i('u_maskSrc', opts.mask ? 1 : 0)
        .i('u_hasAdd', opts.add ? 1 : 0)
      if (opts.mask) p.i4('u_srcRect', ...opts.mask)
      if (opts.add) p.i4('u_addRect', ...opts.add.rect)
      const d = opts.depth
      if (d) p.f('u_cap', d.cap[0]!, d.cap[1]!, d.cap[2]!, d.cap[3]!).f('u_m', d.m[0]!, d.m[1]!, d.m[2]!, d.m[3]!).f('u_b', d.b[0]!, d.b[1]!, d.b[2]!, d.b[3]!).f('u_c', d.c[0]!, d.c[1]!, d.c[2]!, d.c[3]!)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    let activeBins = 0
    /** Diffuse the pending time; the H pass also lands the last spread fresh heat. */
    const flush = () => {
      const dt = r.pending
      r.pending = 0
      if (dt <= 0) return
      gl.disable(gl.BLEND)
      gl.bindVertexArray(this.emptyVao)
      gl.viewport(0, 0, W, H)
      const taps = this.taps(plan.alphaMm2PerS, dt, pitchMm)
      lateral(s0.tex, s1, taps, [1, 0], r.freshRect ? { add: { tex: freshSpread.tex, rect: r.freshRect } } : {})
      lateral(s1.tex, s0, taps, [0, 1], { depth: depthSolver(plan.layerMm, plan.alphaMm2PerS, dt) })
      r.freshRect = null
    }

    const runGather = (first: number, count: number, final: boolean, base: number) => {
      gl.disable(gl.BLEND)
      const out = final ? perSample : pre
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
      gl.viewport(0, 0, PER_SAMPLE_WIDTH, final ? rows : r.preRows)
      gl.bindVertexArray(this.vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, s0.tex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, dose.tex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, final ? pre.tex : null)
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, r.freshRect ? freshSpread.tex : null)
      const p = gridUniforms(this.gather.use())
        .i('u_state', 0)
        .i('u_doseAcc', 1)
        .i('u_pre', 2)
        .i('u_fresh', 3)
        .i('u_hasFresh', r.freshRect ? 1 : 0)
        .i('u_binFirst', first)
        .i('u_base', base)
        .i('u_final', final ? 1 : 0)
        .i('u_outSize', PER_SAMPLE_WIDTH, final ? rows : r.preRows)
        .f('u_absorption', material.absorption)
        .f('u_absorptionFull', thermal.absorptionAtFullChar ?? material.absorption)
        .i('u_feedback', feedback ? 1 : 0)
        .f('u_rampStart', ramp.rampStart)
        .f('u_rampEnd', ramp.rampEnd)
        .f('u_gamma', ramp.gamma)
      if (r.freshRect) p.i4('u_freshRect', ...r.freshRect)
      gl.drawArrays(gl.POINTS, first - base, count)
    }

    const zero = new Float32Array(4)
    /** Inject [first, first + count) into the fresh texture (and dose), then spread it laterally inside its rect. */
    const runInject = (first: number, count: number, base: number) => {
      // The rect the spread heat can reach: the bilinear footprint plus the spread taps.
      let cx0 = Infinity
      let cy0 = Infinity
      let cx1 = -Infinity
      let cy1 = -Infinity
      const { xye } = store
      for (let i = first; i < first + count; i++) {
        const fx = Math.floor((xye[i * 3]! - plan.grid.originXMm) / pitchMm - 0.5)
        const fy = Math.floor((xye[i * 3 + 1]! - plan.grid.originYMm) / pitchMm - 0.5)
        if (fx < cx0) cx0 = fx
        if (fx > cx1) cx1 = fx
        if (fy < cy0) cy0 = fy
        if (fy > cy1) cy1 = fy
      }
      const m = spreadTaps.radius + 1
      const rect: Rect = [Math.max(0, cx0 - m), Math.max(0, cy0 - m), Math.min(W, cx1 + 2 + m), Math.min(H, cy1 + 2 + m)]
      const [x0, y0, x1, y1] = rect
      gl.bindFramebuffer(gl.FRAMEBUFFER, injectFbo)
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
      gl.viewport(0, 0, W, H)
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(x0, y0, x1 - x0, y1 - y0)
      gl.clearBufferfv(gl.COLOR, 0, zero)
      gl.enable(gl.BLEND)
      gl.blendEquation(gl.FUNC_ADD)
      gl.blendFunc(gl.ONE, gl.ONE)
      // Instanced: the sample attribute steps per instance, from `first` (chunk-relative offset).
      gl.bindVertexArray(this.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.window.buffer)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, CHUNK_STRIDE * 4, (first - base) * CHUNK_STRIDE * 4)
      gl.vertexAttribDivisor(0, 1)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, perSample.tex)
      gridUniforms(this.inject.use())
        .i('u_perSample', 0)
        .i('u_first', first)
        .f('u_layerScale', layerScale[0]!, layerScale[1]!, layerScale[2]!, layerScale[3]!)
        .f('u_invArea', 1 / area)
      gl.drawArraysInstanced(gl.POINTS, 0, 4, count)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, CHUNK_STRIDE * 4, 0)
      gl.vertexAttribDivisor(0, 0)
      gl.disable(gl.BLEND)
      gl.bindVertexArray(this.emptyVao)
      lateral(fresh.tex, freshTmp, spreadTaps, [1, 0], { mask: rect })
      lateral(freshTmp.tex, freshSpread, spreadTaps, [0, 1], { mask: rect })
      gl.disable(gl.SCISSOR_TEST)
      r.freshRect = rect
      r.live = true
    }

    for (let k = fromBin; k < plan.binCount + plan.lagBins; k++) {
      if (k === last) {
        // Where the next call resumes: the grid at the start of the last bin.
        this.copy(s0, r.snap.s0)
        this.copy(dose, r.snap.dose)
        if (r.freshRect) this.copy(freshSpread, r.snap.freshSpread)
        r.snap.pending = r.pending
        r.snap.live = r.live
        r.snap.freshRect = r.freshRect
      }
      const j = k - plan.lagBins
      const injFrom = j >= 0 && j < plan.binCount ? binStart[j]! : 0
      const injTo = j >= 0 && j < plan.binCount ? binStart[j + 1]! : 0
      const gatFrom = k < plan.binCount ? binStart[k]! : 0
      const gatTo = k < plan.binCount ? binStart[k + 1]! : 0
      if (injTo > injFrom || gatTo > gatFrom) {
        activeBins++
        flush()
        // The lagged bin injected and the bin gathered, in one chunk (injection's bin comes first).
        const lo = injTo > injFrom ? injFrom : gatFrom
        const hi = gatTo > gatFrom ? gatTo : injTo
        const base = this.chunk(store, statics, lo, hi)
        if (gatTo > gatFrom) runGather(gatFrom, gatTo - gatFrom, false, base)
        if (injTo > injFrom) runInject(injFrom, injTo - injFrom, base)
        if (gatTo > gatFrom) runGather(gatFrom, gatTo - gatFrom, true, base)
      }
      if (r.live) r.pending += plan.binS
    }
    gl.bindVertexArray(null)

    // Bulk map on the GPU (MAX blend) over the samples gathered here, then read back: it is small.
    const bulk = r.bulk
    gl.bindFramebuffer(gl.FRAMEBUFFER, bulk.fbo)
    gl.viewport(0, 0, W, H)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.MAX)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, perSample.tex)
    gridUniforms(this.bulkProgram.use()).i('u_perSample', 0)
    // MAX blend: chunk order doesn't matter. Starts with the chunk the loop left, if it is in range.
    for (let lo = first; lo < n; ) {
      const base = this.chunk(store, statics, lo, lo + 1)
      const hi = Math.min(n, this.window.to)
      this.bulkProgram.i('u_base', base)
      gl.drawArrays(gl.POINTS, lo - base, hi - lo)
      lo = hi
    }
    gl.blendEquation(gl.FUNC_ADD)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.finish()
    const t2 = performance.now()
    const bulkK = readR32F(gl, bulk.fbo, W, H)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    r.count = n
    r.storeVersion = store.version
    r.lastT = n ? store.tS[n - 1]! : -Infinity

    // (eAbs, eDose) stay on the GPU until the CPU asks (hover readout, energy checks).
    let arrays: { eAbs: Float32Array; eDose: Float32Array } | null = null
    const tex = perSample.tex
    // Not read back yet and the texture died with a lost context (BURN-39) or was grown by a later extend: reading now gives zeros.
    const lost = () => !arrays && (gl.isContextLost() || !gl.isTexture(tex))
    const readBack = () => {
      if (arrays) return arrays
      if (lost()) throw new GlContextLostError('WebGL context lost before the thermal result was read back')
      const readRows = Math.max(1, Math.ceil(n / PER_SAMPLE_WIDTH))
      const rgRead = (() => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, perSample.fbo)
        gl.readBuffer(gl.COLOR_ATTACHMENT0)
        return gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RG && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT
      })()
      const channels = rgRead ? 2 : 4
      const raw = new Float32Array(PER_SAMPLE_WIDTH * readRows * channels)
      gl.readPixels(0, 0, PER_SAMPLE_WIDTH, readRows, rgRead ? gl.RG : gl.RGBA, gl.FLOAT, raw)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const eAbs = new Float32Array(n)
      const eDose = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        eAbs[i] = raw[i * channels]!
        eDose[i] = raw[i * channels + 1]!
      }
      return (arrays = { eAbs, eDose })
    }
    this.materialize = readBack
    this.current = {
      count: n,
      storeVersion: store.version,
      get eAbs() {
        return readBack().eAbs
      },
      get eDose() {
        return readBack().eDose
      },
      get lost() {
        return lost()
      },
      bulkK,
      plan,
      ambientK: thermal.ambientK,
      flashK: flashKPerJPerMm2(material, thermal),
      perSample: perSample.tex,
      bulk: bulk.tex,
      gpuMs: performance.now() - t0,
      timing: { staticsMs: t1 - t0, loopMs: t2 - t1, readbackMs: performance.now() - t2 },
      activeBins,
      extended,
    }
    return this.current
  }
}

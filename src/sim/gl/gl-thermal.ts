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
  peakTemperatureModel,
  thermalPlanFor,
  thermalStatics,
  type ThermalResult,
  type ThermalStep,
} from '../thermal.ts'
import { GlContextLostError, Program, deleteTexture, framebuffer, target, texture, type Target } from './gl-util.ts'
import { FULLSCREEN_VS } from './shaders.ts'
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
  activeBins: number
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
  private readonly staticBuffer: WebGLBuffer
  private readonly tapTextures = new Map<string, WebGLTexture>()
  private owned: WebGLTexture[] = []
  private ownedFbos: WebGLFramebuffer[] = []
  /** The last run's result while its textures are alive. */
  current: GlThermalResult | null = null
  /** Reads the current result's per-sample energies back (once), so they outlive its textures. */
  private materialize: (() => unknown) | null = null
  private readonly bulkProgram: Program

  constructor(
    readonly gl: WebGL2RenderingContext,
    /** The sample buffer GlSim keeps in sync with the store (interleaved x, y, E). */
    private readonly sampleBuffer: () => WebGLBuffer,
  ) {
    this.diffuse = new Program(gl, FULLSCREEN_VS, THERMAL_DIFFUSE_FS)
    this.inject = new Program(gl, THERMAL_INJECT_VS, THERMAL_INJECT_FS)
    this.gather = new Program(gl, THERMAL_GATHER_VS, THERMAL_GATHER_FS)
    this.bulkProgram = new Program(gl, THERMAL_BULK_VS, THERMAL_BULK_FS)
    this.vao = gl.createVertexArray()!
    this.emptyVao = gl.createVertexArray()!
    this.staticBuffer = gl.createBuffer()!
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

  run(store: SampleStore, machine: MachineProfile, material: MaterialProfile, kernel: KernelSigma): GlThermalResult {
    const thermal = peakTemperatureModel(material)
    if (!thermal) throw new Error('GlPeakTemperatureStep: material has no peakTemperature thermal model')
    const gl = this.gl
    const t0 = performance.now()
    this.release()
    const plan = thermalPlanFor(store, thermal)
    const table = cachedFlashTable(machine, kernel, thermal, plan.nearS)
    const st = thermalStatics(store, plan, table, material, thermal)
    const n = store.count
    const { width: W, height: H, pitchMm } = plan.grid

    // Static per-sample attributes: flash factor, bulk gain, bin fraction.
    const statics = new Float32Array(n * 3)
    for (let k = 0; k < plan.binCount; k++)
      for (let i = st.binStart[k]!; i < st.binStart[k + 1]!; i++) {
        statics[i * 3] = st.flash[i]!
        statics[i * 3 + 1] = st.bulkGain[i]!
        statics[i * 3 + 2] = binFraction(store.tS[i]!, k, plan.binS)
      }
    const t1 = performance.now()
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sampleBuffer())
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.staticBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, statics, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(1, 0)
    gl.bindVertexArray(null)

    // Thermal grid state (ping-pong), accumulated dose, per-sample outputs.
    const own = <T extends WebGLTexture>(t: T) => (this.owned.push(t), t)
    const ownTarget = (internal: number, w: number, h: number): Target => {
      const t = target(gl, internal, w, h)
      this.owned.push(t.tex)
      this.ownedFbos.push(t.fbo)
      return t
    }
    const s0 = ownTarget(gl.RGBA32F, W, H)
    const s1 = ownTarget(gl.RGBA32F, W, H)
    const fresh = ownTarget(gl.RGBA32F, W, H)
    const freshTmp = ownTarget(gl.RGBA32F, W, H)
    const freshSpread = ownTarget(gl.RGBA32F, W, H)
    const dose = own(texture(gl, gl.R32F, W, H))
    const injectFbo = framebuffer(gl, fresh.tex, dose)
    this.ownedFbos.push(injectFbo)
    for (const fbo of [s0.fbo, s1.fbo, injectFbo]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    const rows = Math.max(1, Math.ceil(n / PER_SAMPLE_WIDTH))
    const perSample = ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, rows)
    let widest = 1
    for (let k = 0; k < plan.binCount; k++) widest = Math.max(widest, st.binStart[k + 1]! - st.binStart[k]!)
    const preRows = Math.ceil(widest / PER_SAMPLE_WIDTH)
    const pre = ownTarget(gl.RG32F, PER_SAMPLE_WIDTH, preRows)

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
    type Rect = [x0: number, y0: number, x1: number, y1: number]
    /** Where the last injection's spread heat lives, until the next diffusion lands it in the state. */
    let freshRect: Rect | null = null

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

    let pending = 0
    let live = false
    let activeBins = 0
    /** Diffuse the pending time; the H pass also lands the last spread fresh heat. */
    const flush = () => {
      const dt = pending
      pending = 0
      if (dt <= 0) return
      gl.disable(gl.BLEND)
      gl.bindVertexArray(this.emptyVao)
      gl.viewport(0, 0, W, H)
      const taps = this.taps(plan.alphaMm2PerS, dt, pitchMm)
      lateral(s0.tex, s1, taps, [1, 0], freshRect ? { add: { tex: freshSpread.tex, rect: freshRect } } : {})
      lateral(s1.tex, s0, taps, [0, 1], { depth: depthSolver(plan.layerMm, plan.alphaMm2PerS, dt) })
      freshRect = null
    }

    const runGather = (first: number, count: number, final: boolean) => {
      gl.disable(gl.BLEND)
      const out = final ? perSample : pre
      gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
      gl.viewport(0, 0, PER_SAMPLE_WIDTH, final ? rows : preRows)
      gl.bindVertexArray(this.vao)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, s0.tex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, dose)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, final ? pre.tex : null)
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, freshRect ? freshSpread.tex : null)
      const p = gridUniforms(this.gather.use())
        .i('u_state', 0)
        .i('u_doseAcc', 1)
        .i('u_pre', 2)
        .i('u_fresh', 3)
        .i('u_hasFresh', freshRect ? 1 : 0)
        .i('u_binFirst', first)
        .i('u_final', final ? 1 : 0)
        .i('u_outSize', PER_SAMPLE_WIDTH, final ? rows : preRows)
        .f('u_absorption', material.absorption)
        .f('u_absorptionFull', thermal.absorptionAtFullChar ?? material.absorption)
        .i('u_feedback', feedback ? 1 : 0)
        .f('u_rampStart', ramp.rampStart)
        .f('u_rampEnd', ramp.rampEnd)
        .f('u_gamma', ramp.gamma)
      if (freshRect) p.i4('u_freshRect', ...freshRect)
      gl.drawArrays(gl.POINTS, first, count)
    }

    const zero = new Float32Array(4)
    /** Inject [first, first + count) into the fresh texture (and dose), then spread it laterally inside its rect. */
    const runInject = (first: number, count: number) => {
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
      // Instanced: the sample attribute steps per instance, from `first`.
      gl.bindVertexArray(this.vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sampleBuffer())
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, first * 12)
      gl.vertexAttribDivisor(0, 1)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, perSample.tex)
      gridUniforms(this.inject.use())
        .i('u_perSample', 0)
        .i('u_first', first)
        .f('u_layerScale', layerScale[0]!, layerScale[1]!, layerScale[2]!, layerScale[3]!)
        .f('u_invArea', 1 / area)
      gl.drawArraysInstanced(gl.POINTS, 0, 4, count)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
      gl.vertexAttribDivisor(0, 0)
      gl.disable(gl.BLEND)
      gl.bindVertexArray(this.emptyVao)
      lateral(fresh.tex, freshTmp, spreadTaps, [1, 0], { mask: rect })
      lateral(freshTmp.tex, freshSpread, spreadTaps, [0, 1], { mask: rect })
      gl.disable(gl.SCISSOR_TEST)
      freshRect = rect
      live = true
    }

    for (let k = 0; k < plan.binCount + plan.lagBins; k++) {
      const j = k - plan.lagBins
      const injFrom = j >= 0 && j < plan.binCount ? st.binStart[j]! : 0
      const injTo = j >= 0 && j < plan.binCount ? st.binStart[j + 1]! : 0
      const gatFrom = k < plan.binCount ? st.binStart[k]! : 0
      const gatTo = k < plan.binCount ? st.binStart[k + 1]! : 0
      if (injTo > injFrom || gatTo > gatFrom) {
        activeBins++
        flush()
        if (gatTo > gatFrom) runGather(gatFrom, gatTo - gatFrom, false)
        if (injTo > injFrom) runInject(injFrom, injTo - injFrom)
        if (gatTo > gatFrom) runGather(gatFrom, gatTo - gatFrom, true)
      }
      if (live) pending += plan.binS
    }
    gl.bindVertexArray(null)

    // Bulk map on the GPU (MAX blend), then read back: it is small.
    const bulk = ownTarget(gl.R32F, W, H)
    gl.bindFramebuffer(gl.FRAMEBUFFER, bulk.fbo)
    gl.viewport(0, 0, W, H)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.MAX)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, perSample.tex)
    gridUniforms(this.bulkProgram.use()).i('u_perSample', 0)
    gl.drawArrays(gl.POINTS, 0, n)
    gl.blendEquation(gl.FUNC_ADD)
    gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.finish()
    const t2 = performance.now()
    const bulkK = readR32F(gl, bulk.fbo, W, H)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    // (eAbs, eDose) stay on the GPU until the CPU asks (hover readout, energy checks).
    let arrays: { eAbs: Float32Array; eDose: Float32Array } | null = null
    // Not read back yet and the texture died with a lost context (BURN-39): reading now gives zeros.
    const lost = () => !arrays && (gl.isContextLost() || !gl.isTexture(perSample.tex))
    const readBack = () => {
      if (arrays) return arrays
      if (lost()) throw new GlContextLostError('WebGL context lost before the thermal result was read back')
      const rgRead = (() => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, perSample.fbo)
        gl.readBuffer(gl.COLOR_ATTACHMENT0)
        return gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RG && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT
      })()
      const channels = rgRead ? 2 : 4
      const raw = new Float32Array(PER_SAMPLE_WIDTH * rows * channels)
      gl.readPixels(0, 0, PER_SAMPLE_WIDTH, rows, rgRead ? gl.RG : gl.RGBA, gl.FLOAT, raw)
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
    }
    return this.current
  }
}

// SPDX-License-Identifier: MIT
// Burn view on WebGL2 (COD-259): draws the pipeline's outputs to the UI canvas
// as a realistic burn (burn-view.ts is the CPU reference), with pan and zoom.
//
// Layers, all in the GlSim's context:
//   full     the job overview (≤ 4096², every tile box-filtered), from GlSim.run
//   coarse   the scrub preview overview (≤ 1024²), from GlSim.runCoarse
//   detail   a 1:1 window of the job grid around the view, from a region run
//            (GlSim.run with `region`), so striping and corner scorch show at
//            grid pitch without holding full-res tiles.
// A draw shades one base layer (full or coarse) with the detail layer on top
// where it covers the view. Nothing runs per frame: the caller draws on change.

import type { CellRect, GridSpec, MaterialProfile } from '../../contract/index.ts'
import {
  FIRE_DARK_RGB,
  HALO_ALPHA,
  HALO_MM,
  OVERLAY_ALPHA,
  REGION_MIN_COVER,
  REGION_MM,
  TEXTURE_KIND,
  VERDICT_RGB,
  burnViewParams,
  type BurnViewOptions,
  type BurnViewParams,
} from '../burn-view.ts'
import type { SimSetup } from '../job.ts'
import type { SampleStore } from '../sample-store.ts'
import { BURN_VIEW_FS, DETAIL_PACK_FS, VERDICT_SUMMARY_FS } from './burn-view-shaders.ts'
import { GlOverview, mipTexture, type GlRunResult, type GlSim } from './gl-sim.ts'
import { Program, deleteTexture, framebuffer, target, texture, type Target } from './gl-util.ts'
import { FULLSCREEN_VS } from './shaders.ts'

/** One drawable layer: textures plus where their texels sit in mm. */
export interface BurnLayer {
  color: WebGLTexture
  field: WebGLTexture
  /** Per-bucket coverage, mipmapped (the overlay's regions). */
  cover: WebGLTexture
  /** Worst verdict per texel (R8UI): the summary. */
  verdict: WebGLTexture
  originXMm: number
  originYMm: number
  texelMm: number
  /** Valid texels. */
  width: number
  height: number
  /** Allocated texels (≥ width × height); uv = texel / capacity. */
  capWidth: number
  capHeight: number
}

/** View transform: canvas centre in mm and mm per device pixel. Y up. */
export interface BurnViewport {
  centerXMm: number
  centerYMm: number
  mmPerPx: number
}

export interface VerdictSummary {
  width: number
  height: number
  originXMm: number
  originYMm: number
  texelMm: number
  /** Worst verdict per texel, row 0 = min Y. */
  verdict: Uint8Array
}

export interface Heightmap {
  width: number
  height: number
  originXMm: number
  originYMm: number
  texelMm: number
  /** Depth (mm, ≥ 0), row 0 = min Y. */
  depthMm: Float32Array
  /** Shaded colour without relief or overlay (sRGB RGBA8), row 0 = min Y. */
  color: Uint8Array
}

/** The overview as a layer, or null before anything was composited into it. */
export function overviewLayer(ov: GlOverview): BurnLayer | null {
  if (!ov.grid || !ov.color || !ov.field || !ov.cover || !ov.verdict) return null
  return {
    color: ov.color,
    field: ov.field,
    cover: ov.cover,
    verdict: ov.verdict,
    originXMm: ov.grid.originXMm,
    originYMm: ov.grid.originYMm,
    texelMm: ov.grid.pitchMm * ov.cellsPerPixel,
    width: ov.width,
    height: ov.height,
    capWidth: ov.width,
    capHeight: ov.height,
  }
}

/** Detail textures, allocated in 256-texel steps and reused while they fit. */
class DetailTargets {
  readonly color: WebGLTexture
  readonly field: WebGLTexture
  readonly cover: WebGLTexture
  readonly verdict: WebGLTexture
  readonly fbo: WebGLFramebuffer

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly capWidth: number,
    readonly capHeight: number,
  ) {
    this.color = mipTexture(gl, gl.RGBA8, capWidth, capHeight)
    this.verdict = texture(gl, gl.R8UI, capWidth, capHeight)
    this.field = mipTexture(gl, gl.RGBA16F, capWidth, capHeight)
    this.cover = mipTexture(gl, gl.RGBA16F, capWidth, capHeight)
    this.fbo = framebuffer(gl, this.color, this.verdict, this.field, this.cover)
  }

  dispose(): void {
    for (const t of [this.color, this.field, this.cover, this.verdict]) deleteTexture(this.gl, t)
    this.gl.deleteFramebuffer(this.fbo)
  }
}

export class GlBurnView {
  readonly gl: WebGL2RenderingContext
  /** Full-resolution overview (GlSim.run's `overview`). */
  readonly full: GlOverview
  /** Scrub preview overview (GlSim.runCoarse's `overview`), kept apart so neither reallocates the other. */
  readonly coarse: GlOverview
  private readonly program: Program
  private readonly pack: Program
  private readonly summaryProgram: Program
  private readonly vao: WebGLVertexArrayObject
  private params: BurnViewParams | null = null
  private detailTargets: DetailTargets | null = null
  /** The detail layer, or null when the view is coarse enough for the overview. */
  detail: BurnLayer | null = null
  private offscreen: { w: number; h: number; color: WebGLTexture; depth: WebGLTexture; fbo: WebGLFramebuffer } | null = null

  constructor(readonly sim: GlSim) {
    const gl = (this.gl = sim.gl)
    this.full = new GlOverview(gl)
    this.coarse = new GlOverview(gl, 1024)
    this.program = new Program(gl, FULLSCREEN_VS, BURN_VIEW_FS)
    this.pack = new Program(gl, FULLSCREEN_VS, DETAIL_PACK_FS)
    this.summaryProgram = new Program(gl, FULLSCREEN_VS, VERDICT_SUMMARY_FS)
    this.vao = gl.createVertexArray()!
  }

  setMaterial(material: MaterialProfile): void {
    this.params = burnViewParams(material)
  }

  /** Full-resolution run of the whole job into the full overview. */
  runFull(store: SampleStore, setup: SimSetup, cutoffS: number): GlRunResult {
    return this.sim.run(store, setup, { timeCutoffS: cutoffS, overview: this.full })
  }

  /** Coarse scrub preview into the coarse overview. */
  runCoarse(store: SampleStore, setup: SimSetup, cutoffS: number): GlRunResult {
    return this.sim.runCoarse(store, setup, cutoffS, { overview: this.coarse })
  }

  /**
   * Runs `rect` of the job grid at full resolution and keeps it as the detail
   * layer. Cost is the samples in bins near the rect plus a rect-sized blur.
   */
  runDetail(store: SampleStore, setup: SimSetup, rect: CellRect, cutoffS: number): GlRunResult {
    const gl = this.gl
    const { grid } = setup
    let layer: BurnLayer | null = null
    const result = this.sim.run(store, setup, {
      timeCutoffS: cutoffS,
      region: rect,
      onTile: (t) => {
        const { core, padded } = t.tile
        const cap = (n: number) => Math.ceil(n / 256) * 256
        let dt = this.detailTargets
        if (!dt || dt.capWidth < core.width || dt.capHeight < core.height) {
          dt?.dispose()
          dt = this.detailTargets = new DetailTargets(gl, cap(Math.max(core.width, dt?.capWidth ?? 0)), cap(Math.max(core.height, dt?.capHeight ?? 0)))
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, dt.fbo)
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3])
        gl.viewport(0, 0, dt.capWidth, dt.capHeight)
        gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0])
        gl.clearBufferuiv(gl.COLOR, 1, [0, 0, 0, 0])
        gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0])
        gl.clearBufferfv(gl.COLOR, 3, [0, 0, 0, 0])
        gl.viewport(0, 0, core.width, core.height)
        gl.disable(gl.BLEND)
        const bind = (unit: number, tex: WebGLTexture) => {
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, tex)
        }
        bind(0, t.color)
        bind(1, t.fluence)
        bind(2, t.depth)
        bind(3, t.verdict)
        this.pack
          .use()
          .i('u_color', 0)
          .i('u_fluence', 1)
          .i('u_depth', 2)
          .i('u_verdict', 3)
          .i('u_offset', core.x - padded.x, core.y - padded.y)
        gl.bindVertexArray(this.vao)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        for (const tex of [dt.color, dt.field, dt.cover]) {
          gl.bindTexture(gl.TEXTURE_2D, tex)
          gl.generateMipmap(gl.TEXTURE_2D)
        }
        layer = {
          color: dt.color,
          field: dt.field,
          cover: dt.cover,
          verdict: dt.verdict,
          originXMm: grid.originXMm + core.x * grid.pitchMm,
          originYMm: grid.originYMm + core.y * grid.pitchMm,
          texelMm: grid.pitchMm,
          width: core.width,
          height: core.height,
          capWidth: dt.capWidth,
          capHeight: dt.capHeight,
        }
      },
    })
    this.detail = layer
    return result
  }

  clearDetail(): void {
    this.detail = null
  }

  /** Releases the overviews, detail and offscreen targets (the GlSim keeps its own). */
  dispose(): void {
    this.full.dispose()
    this.coarse.dispose()
    this.detailTargets?.dispose()
    this.detailTargets = null
    this.detail = null
    this.dropOffscreen()
  }

  private dropOffscreen(): void {
    const o = this.offscreen
    if (!o) return
    deleteTexture(this.gl, o.color)
    deleteTexture(this.gl, o.depth)
    this.gl.deleteFramebuffer(o.fbo)
    this.offscreen = null
  }

  /**
   * Draws base (and detail on top, where it covers) to the canvas, or into
   * `fbo` of size width × height. Without a base layer it draws the bare sheet.
   */
  draw(
    base: BurnLayer | null,
    detail: BurnLayer | null,
    view: BurnViewport,
    options: BurnViewOptions,
    out: { fbo: WebGLFramebuffer | null; width: number; height: number } = {
      fbo: null,
      width: this.gl.drawingBufferWidth,
      height: this.gl.drawingBufferHeight,
    },
  ): void {
    const gl = this.gl
    const p = this.params
    if (!p) throw new Error('GlBurnView: setMaterial first')
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo)
    if (out.fbo) gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    gl.viewport(0, 0, out.width, out.height)
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    const prog = this.program.use()
    const bindLayer = (n: 0 | 1, layer: BurnLayer | null) => {
      prog.i(`u_has${n}`, layer ? 1 : 0)
      if (!layer) return
      const unit = n * 3
      for (const [k, tex] of [
        [0, layer.color],
        [1, layer.field],
        [2, layer.cover],
      ] as const) {
        gl.activeTexture(gl.TEXTURE0 + unit + k)
        gl.bindTexture(gl.TEXTURE_2D, tex)
      }
      prog
        .i(`u_color${n}`, unit)
        .i(`u_field${n}`, unit + 1)
        .i(`u_cover${n}`, unit + 2)
        .f(`u_origin${n}`, layer.originXMm, layer.originYMm)
        .f(`u_texel${n}`, layer.texelMm)
        .f(`u_size${n}`, layer.width, layer.height)
        .f(`u_cap${n}`, layer.capWidth, layer.capHeight)
    }
    bindLayer(0, base)
    bindLayer(1, detail)
    // Unused sampler units still need a texture of the right kind bound; point them at the base layer's.
    if (!detail && base) prog.i('u_color1', 0).i('u_field1', 1).i('u_cover1', 2)
    if (!base) {
      if (detail) prog.i('u_color0', 3).i('u_field0', 4).i('u_cover0', 5)
      else this.bindDummies(prog)
    }
    prog
      .f('u_canvas', out.width, out.height)
      .f('u_center', view.centerXMm, view.centerYMm)
      .f('u_mmPerPx', view.mmPerPx)
      .i('u_texture', TEXTURE_KIND[p.texture])
      .f('u_base', ...p.base)
      .f('u_halo', ...p.halo)
      .f('u_rampStart', p.rampStart)
      .f('u_rampEnd', p.rampEnd)
      .f('u_gamma', p.gamma)
      .i('u_haloOn', options.halo && p.haloEnabled ? 1 : 0)
      .i('u_relief', options.relief ? 1 : 0)
      .i('u_overlay', options.overlay ? 1 : 0)
      .f('u_regionMm', REGION_MM)
      .f('u_regionMinCover', REGION_MIN_COVER)
      .f('u_haloMm', HALO_MM)
      .f('u_haloAlpha', HALO_ALPHA)
      .f('u_overlayAlpha', OVERLAY_ALPHA)
      .f('u_fireDark', ...FIRE_DARK_RGB.map((c) => c / 255))
    gl.uniform3fv(prog.loc('u_verdictRgb'), VERDICT_RGB.flatMap((rgb) => rgb.map((c) => c / 255)))
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  private dummy: WebGLTexture | null = null
  private bindDummies(prog: Program): void {
    const gl = this.gl
    this.dummy ??= texture(gl, gl.RGBA8, 1, 1)
    for (let unit = 0; unit < 6; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, this.dummy)
    }
    prog.i('u_color0', 0).i('u_field0', 1).i('u_cover0', 2).i('u_color1', 3).i('u_field1', 4).i('u_cover1', 5)
  }

  /** Worst verdict per block, at most maxSide texels a side (one small readback). */
  summary(layer: BurnLayer, maxSide = 256): VerdictSummary {
    const gl = this.gl
    const block = Math.max(1, Math.ceil(Math.max(layer.width, layer.height) / maxSide))
    const w = Math.ceil(layer.width / block)
    const h = Math.ceil(layer.height / block)
    const t: Target = target(gl, gl.R8UI, w, h)
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, layer.verdict)
    this.summaryProgram.use().i('u_verdict', 0).f('u_size', layer.width, layer.height).f('u_block', block)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    const raw = new Uint32Array(w * h * 4)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, raw)
    deleteTexture(gl, t.tex)
    gl.deleteFramebuffer(t.fbo)
    const verdict = new Uint8Array(w * h)
    for (let i = 0; i < verdict.length; i++) verdict[i] = raw[i * 4]!
    return { width: w, height: h, originXMm: layer.originXMm, originYMm: layer.originYMm, texelMm: layer.texelMm * block, verdict }
  }

  private offscreenTarget(w: number, h: number) {
    const gl = this.gl
    if (this.offscreen && this.offscreen.w === w && this.offscreen.h === h) return this.offscreen
    this.dropOffscreen()
    const color = texture(gl, gl.RGBA8, w, h)
    const depth = texture(gl, gl.R32F, w, h)
    this.offscreen = { w, h, color, depth, fbo: framebuffer(gl, color, depth) }
    return this.offscreen
  }

  /** Renders `area` (mm) at `texelMm` per pixel offscreen; pixels row 0 = min Y. */
  private renderArea(
    base: BurnLayer | null,
    detail: BurnLayer | null,
    area: { originXMm: number; originYMm: number; width: number; height: number; texelMm: number },
    options: BurnViewOptions,
  ) {
    const o = this.offscreenTarget(area.width, area.height)
    this.draw(
      base,
      detail,
      {
        centerXMm: area.originXMm + (area.width * area.texelMm) / 2,
        centerYMm: area.originYMm + (area.height * area.texelMm) / 2,
        mmPerPx: area.texelMm,
      },
      options,
      { fbo: o.fbo, width: area.width, height: area.height },
    )
    return o
  }

  /** The shaded view of a layer at its own resolution, for export. Rows top-down (PNG order). */
  renderImage(layer: BurnLayer, options: BurnViewOptions): { width: number; height: number; rgba: Uint8Array } {
    const gl = this.gl
    const { width, height } = layer
    this.renderArea(layer, null, layer, options)
    const raw = new Uint8Array(width * height * 4)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const rgba = new Uint8Array(raw.length)
    const row = width * 4
    for (let y = 0; y < height; y++) rgba.set(raw.subarray((height - 1 - y) * row, (height - y) * row), y * row)
    return { width, height, rgba }
  }

  /** Depth and plain shaded colour of a layer at most maxSide texels a side (3D view, height export). */
  heightmap(layer: BurnLayer, maxSide = 1024): Heightmap {
    const gl = this.gl
    const scale = Math.max(1, Math.max(layer.width, layer.height) / maxSide)
    const width = Math.max(1, Math.round(layer.width / scale))
    const height = Math.max(1, Math.round(layer.height / scale))
    const texelMm = (layer.width * layer.texelMm) / width
    const area = { originXMm: layer.originXMm, originYMm: layer.originYMm, width, height, texelMm }
    this.renderArea(layer, null, area, { relief: false, halo: true, overlay: false })
    const color = new Uint8Array(width * height * 4)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, color)
    const rgbaDepth = new Float32Array(width * height * 4)
    gl.readBuffer(gl.COLOR_ATTACHMENT1)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, rgbaDepth)
    const depthMm = new Float32Array(width * height)
    for (let i = 0; i < depthMm.length; i++) depthMm[i] = rgbaDepth[i * 4]!
    return { width, height, originXMm: layer.originXMm, originYMm: layer.originYMm, texelMm, depthMm, color }
  }
}

/** Job-grid cells a view shows (clamped to the grid), for the detail run. */
export function visibleCells(grid: GridSpec, view: BurnViewport, canvasW: number, canvasH: number): CellRect | null {
  const halfW = (canvasW * view.mmPerPx) / 2
  const halfH = (canvasH * view.mmPerPx) / 2
  const x0 = Math.max(0, Math.floor((view.centerXMm - halfW - grid.originXMm) / grid.pitchMm))
  const y0 = Math.max(0, Math.floor((view.centerYMm - halfH - grid.originYMm) / grid.pitchMm))
  const x1 = Math.min(grid.width, Math.ceil((view.centerXMm + halfW - grid.originXMm) / grid.pitchMm))
  const y1 = Math.min(grid.height, Math.ceil((view.centerYMm + halfH - grid.originYMm) / grid.pitchMm))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}


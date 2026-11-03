// SPDX-License-Identifier: MIT
// WebGL2 pipeline: deposit → blur H → blur V (sheared for rotated spots) → response, per tile, with
// render targets pooled across tiles and runs (COD-252: reallocating ~GBs of
// float targets per pass stalls the driver). Full-res and coarse runs keep
// separate pools so scrubbing never evicts the full-res targets.
//
// Requires EXT_color_buffer_float (R32F render targets). Without
// EXT_float_blend the deposit runs on the CPU (cpu.ts) and is uploaded.

import type { CellRect, Tile } from '../../contract/index.ts'
import { UNTOUCHED_FRACTION, verdictThresholds } from '../../contract/index.ts'
import { depositCpu, type StageEnergy } from '../cpu.ts'
import { coarseSetup, type SimSetup } from '../job.ts'
import type { Kernel1D, SkewTaps } from '../kernel.ts'
import { responseParams } from '../response.ts'
import { SampleBins } from '../bins.ts'
import type { SampleStore } from '../sample-store.ts'
import {
  BLUR_FS,
  DEPOSIT_FS,
  DEPOSIT_VS,
  FULLSCREEN_VS,
  OVERVIEW_FS,
  REDUCE_FACTOR,
  REDUCE_FS,
  RESPONSE_FS,
  SKEW_BLUR_FS,
} from './shaders.ts'

export interface GlCaps {
  floatBlend: boolean
  maxTextureSize: number
  maxRenderbufferSize: number
  renderer: string
  vendor: string
  timerQuery: boolean
}

export type GlStage = 'deposit' | 'blurH' | 'blurV' | 'response'

export interface GlRunOptions {
  timeCutoffS?: number
  /** Sync (finish + 1-pixel readPixels) after every stage and record per-stage wall time. */
  syncStages?: boolean
  /** Reduce each stage's core energy on the GPU (extra passes; not part of timed work when syncStages is off). */
  measureEnergy?: boolean
  /** Composite every tile into this overview (the UI canvas source). */
  overview?: GlOverview
  /** Called after each tile's response pass, before its targets are reused. */
  onTile?: (tile: GlTileView) => void
}

export interface GlRunResult {
  sampleCount: number
  tileCount: number
  /** Per-stage wall time summed over tiles (ms); only with syncStages. */
  stageMs: Partial<Record<GlStage, number>>
  energy: StageEnergy | null
  cpuDeposit: boolean
}

/** A finished tile's GPU outputs, valid only inside onTile. */
export interface GlTileView {
  tile: Tile
  setup: SimSetup
  /** Blurred fluence (R32F), colour (RGBA8), depth (R32F), verdict (R8UI); padded-rect sized. */
  fluence: WebGLTexture
  color: WebGLTexture
  depth: WebGLTexture
  verdict: WebGLTexture
  /** Read a rect (padded-local cells) back to the CPU. */
  readFluence(rect: CellRect): Float32Array
  readColor(rect: CellRect): Uint8ClampedArray
  readDepth(rect: CellRect): Float32Array
  readVerdict(rect: CellRect): Uint8Array
}

const FLT_BIG = 3.0e38
/** Bin edge in cells for tiled deposit (tiles are up to 9000 cells, so ~18 bins across). */
const BIN_CELLS = 512
/** Coarse checkpoints: at most this many, at least this many samples apart. */
const CHECKPOINT_MAX = 16
const CHECKPOINT_MIN_SPACING = 1 << 16

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`)
  return s
}

class Program {
  readonly program: WebGLProgram
  private readonly locs = new Map<string, WebGLUniformLocation | null>()
  constructor(
    private readonly gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
  ) {
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs))
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program link: ${gl.getProgramInfoLog(p)}`)
    this.program = p
  }
  use(): this {
    this.gl.useProgram(this.program)
    return this
  }
  loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.program, name))
    return this.locs.get(name)!
  }
  f(name: string, ...v: number[]): this {
    const l = this.loc(name)
    if (v.length === 1) this.gl.uniform1f(l, v[0]!)
    else if (v.length === 2) this.gl.uniform2f(l, v[0]!, v[1]!)
    else this.gl.uniform3f(l, v[0]!, v[1]!, v[2]!)
    return this
  }
  i(name: string, ...v: number[]): this {
    const l = this.loc(name)
    if (v.length === 1) this.gl.uniform1i(l, v[0]!)
    else this.gl.uniform2i(l, v[0]!, v[1]!)
    return this
  }
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

function texture(gl: WebGL2RenderingContext, internal: number, w: number, h: number): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

function framebuffer(gl: WebGL2RenderingContext, ...attachments: WebGLTexture[]): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  attachments.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0))
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`)
  return fbo
}

function target(gl: WebGL2RenderingContext, internal: number, w: number, h: number): Target {
  const tex = texture(gl, internal, w, h)
  return { tex, fbo: framebuffer(gl, tex) }
}

/** Render targets for one tile size. */
class TargetSet {
  readonly a: Target
  readonly b: Target
  readonly color: WebGLTexture
  readonly depth: WebGLTexture
  readonly verdict: WebGLTexture
  readonly responseFbo: WebGLFramebuffer
  readonly colorFbo: WebGLFramebuffer
  readonly depthFbo: WebGLFramebuffer
  readonly verdictFbo: WebGLFramebuffer

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
  ) {
    this.a = target(gl, gl.R32F, width, height)
    this.b = target(gl, gl.R32F, width, height)
    this.color = texture(gl, gl.RGBA8, width, height)
    this.depth = texture(gl, gl.R32F, width, height)
    this.verdict = texture(gl, gl.R8UI, width, height)
    this.responseFbo = framebuffer(gl, this.color, this.depth, this.verdict)
    this.colorFbo = framebuffer(gl, this.color)
    this.depthFbo = framebuffer(gl, this.depth)
    this.verdictFbo = framebuffer(gl, this.verdict)
  }

  dispose(): void {
    const gl = this.gl
    for (const t of [this.a.tex, this.b.tex, this.color, this.depth, this.verdict]) gl.deleteTexture(t)
    for (const f of [this.a.fbo, this.b.fbo, this.responseFbo, this.colorFbo, this.depthFbo, this.verdictFbo]) gl.deleteFramebuffer(f)
  }
}

/** The UI canvas source: job-wide colour and verdict at display resolution. */
export class GlOverview {
  color: WebGLTexture | null = null
  verdict: WebGLTexture | null = null
  fbo: WebGLFramebuffer | null = null
  width = 0
  height = 0
  /** Job cells per overview pixel (same on both axes). */
  cellsPerPixel = 1

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly maxSide = 4096,
  ) {}

  /** Size for a job grid; reallocates only when the size changes. */
  resize(gridWidth: number, gridHeight: number): void {
    const cpp = Math.max(1, Math.max(gridWidth, gridHeight) / this.maxSide)
    const w = Math.max(1, Math.ceil(gridWidth / cpp))
    const h = Math.max(1, Math.ceil(gridHeight / cpp))
    this.cellsPerPixel = cpp
    if (w === this.width && h === this.height && this.fbo) return
    this.dispose()
    const gl = this.gl
    this.width = w
    this.height = h
    this.color = texture(gl, gl.RGBA8, w, h)
    this.verdict = texture(gl, gl.R8UI, w, h)
    this.fbo = framebuffer(gl, this.color, this.verdict)
  }

  dispose(): void {
    if (this.color) this.gl.deleteTexture(this.color)
    if (this.verdict) this.gl.deleteTexture(this.verdict)
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo)
    this.color = this.verdict = this.fbo = null
    this.width = this.height = 0
  }

  /** Blit the colour overview to the canvas (default framebuffer), letterboxed. Row 0 = min Y = bottom. */
  drawToCanvas(): void {
    const gl = this.gl
    if (!this.fbo) return
    const cw = gl.drawingBufferWidth
    const ch = gl.drawingBufferHeight
    const s = Math.min(cw / this.width, ch / this.height)
    const w = Math.round(this.width * s)
    const h = Math.round(this.height * s)
    const x = Math.floor((cw - w) / 2)
    const y = Math.floor((ch - h) / 2)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.clearColor(0.1, 0.1, 0.1, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.blitFramebuffer(0, 0, this.width, this.height, x, y, x + w, y + h, gl.COLOR_BUFFER_BIT, gl.LINEAR)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
  }

  readColor(): Uint8ClampedArray {
    const gl = this.gl
    const out = new Uint8ClampedArray(this.width * this.height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return out
  }
}

export class GlSim {
  readonly caps: GlCaps
  private readonly deposit: Program
  private readonly blur: Program
  private readonly skewBlur: Program
  private readonly response: Program
  private readonly reduce: Program
  private readonly overviewProgram: Program
  private readonly emptyVao: WebGLVertexArrayObject
  private readonly sampleVao: WebGLVertexArrayObject
  private readonly sampleBuffer: WebGLBuffer
  private sampleCapacity = 0
  private uploadedCount = 0
  private uploadedStore: SampleStore | null = null
  private uploadedVersion = -1
  private readonly pools = new Map<'full' | 'coarse', TargetSet>()
  private readonly weightTextures = new Map<string, WebGLTexture>()
  private readonly reduceTargets = new Map<string, Target>()
  private readonly syncPixel = new Float32Array(4)
  private lastFbo: WebGLFramebuffer | null = null
  private bins: SampleBins | null = null
  private binStore: SampleStore | null = null
  private readonly binBuffer: WebGLBuffer
  private checkpoints: { key: string; store: SampleStore; spacing: number; targets: Target[] } | null = null

  /** `forceCpuDeposit` exercises the no-EXT_float_blend fallback on hardware that has it. */
  constructor(
    readonly gl: WebGL2RenderingContext,
    options: { forceCpuDeposit?: boolean } = {},
  ) {
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2: EXT_color_buffer_float is required')
    const floatBlend = !options.forceCpuDeposit && !!gl.getExtension('EXT_float_blend')
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    this.caps = {
      floatBlend,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      timerQuery: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    }
    this.deposit = new Program(gl, DEPOSIT_VS, DEPOSIT_FS)
    this.blur = new Program(gl, FULLSCREEN_VS, BLUR_FS)
    this.skewBlur = new Program(gl, FULLSCREEN_VS, SKEW_BLUR_FS)
    this.response = new Program(gl, FULLSCREEN_VS, RESPONSE_FS)
    this.reduce = new Program(gl, FULLSCREEN_VS, REDUCE_FS)
    this.overviewProgram = new Program(gl, FULLSCREEN_VS, OVERVIEW_FS)
    this.emptyVao = gl.createVertexArray()!
    this.sampleVao = gl.createVertexArray()!
    this.sampleBuffer = gl.createBuffer()!
    this.binBuffer = gl.createBuffer()!
    gl.bindVertexArray(this.sampleVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sampleBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.bindVertexArray(null)
  }

  /** Upload samples not yet on the GPU (appends only, so live jobs upload incrementally). */
  syncSamples(store: SampleStore): void {
    const gl = this.gl
    if (this.uploadedStore === store && this.uploadedVersion === store.version) return
    if (this.uploadedStore !== store) this.uploadedCount = 0
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sampleBuffer)
    if (store.count > this.sampleCapacity) {
      this.sampleCapacity = Math.max(store.count, Math.ceil(this.sampleCapacity * 1.5), 4096)
      gl.bufferData(gl.ARRAY_BUFFER, this.sampleCapacity * 12, gl.DYNAMIC_DRAW)
      this.uploadedCount = 0
    }
    if (store.count > this.uploadedCount) {
      gl.bufferSubData(gl.ARRAY_BUFFER, this.uploadedCount * 12, store.xye, this.uploadedCount * 3, (store.count - this.uploadedCount) * 3)
      this.uploadedCount = store.count
    }
    this.uploadedStore = store
    this.uploadedVersion = store.version
  }

  private pool(kind: 'full' | 'coarse', w: number, h: number): TargetSet {
    const cur = this.pools.get(kind)
    if (cur && cur.width >= w && cur.height >= h) return cur
    cur?.dispose()
    const next = new TargetSet(this.gl, Math.max(w, cur?.width ?? 0), Math.max(h, cur?.height ?? 0))
    this.pools.set(kind, next)
    return next
  }

  /** Drop pooled targets, coarse checkpoints and bins (e.g. after a large job closes). */
  releaseTargets(): void {
    for (const t of this.pools.values()) t.dispose()
    this.pools.clear()
    this.dropCheckpoints()
    this.bins = this.binStore = null
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.binBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW)
  }

  private dropCheckpoints(): void {
    for (const t of this.checkpoints?.targets ?? []) {
      this.gl.deleteTexture(t.tex)
      this.gl.deleteFramebuffer(t.fbo)
    }
    this.checkpoints = null
  }

  /** Bind `fbo` as the additive deposit target for `rect` of the setup's grid. */
  private beginDeposit(setup: SimSetup, rect: CellRect, fbo: WebGLFramebuffer): void {
    const gl = this.gl
    const { grid, material } = setup
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, rect.width, rect.height)
    gl.enable(gl.BLEND)
    gl.blendEquation(gl.FUNC_ADD)
    gl.blendFunc(gl.ONE, gl.ONE)
    this.deposit
      .use()
      .f('u_origin', grid.originXMm, grid.originYMm)
      .f('u_invPitch', 1 / grid.pitchMm)
      .f('u_rectOffset', rect.x, rect.y)
      .f('u_size', rect.width, rect.height)
      .f('u_scale', material.absorption / (grid.pitchMm * grid.pitchMm))
  }

  /** Draw samples [first, first + count) of `buffer` (interleaved xye) as deposit points. */
  private drawSamples(buffer: WebGLBuffer, first: number, count: number): void {
    if (count <= 0) return
    const gl = this.gl
    gl.bindVertexArray(this.sampleVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, first * 12)
    gl.drawArraysInstanced(gl.POINTS, 0, 4, count)
  }

  /** Multi-tile deposit: only the bins that can reach this tile's padded rect. */
  private depositBinned(store: SampleStore, setup: SimSetup, padded: CellRect, cutoffS: number): void {
    const gl = this.gl
    const { grid } = setup
    const bucketMm = BIN_CELLS * grid.pitchMm
    if (!this.bins || this.binStore !== store || this.bins.version !== store.version || this.bins.bucketMm !== bucketMm) {
      this.bins = new SampleBins(store, bucketMm)
      this.binStore = store
      gl.bindBuffer(gl.ARRAY_BUFFER, this.binBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.bins.xye, gl.STATIC_DRAW)
    }
    // One cell of slack for the bilinear footprint; anything else off the rect is clipped.
    const x0 = grid.originXMm + (padded.x - 1) * grid.pitchMm
    const y0 = grid.originYMm + (padded.y - 1) * grid.pitchMm
    const x1 = grid.originXMm + (padded.x + padded.width + 1) * grid.pitchMm
    const y1 = grid.originYMm + (padded.y + padded.height + 1) * grid.pitchMm
    for (const [first, count] of this.bins.ranges(x0, y0, x1, y1, cutoffS)) this.drawSamples(this.binBuffer, first, count)
  }

  /**
   * Coarse deposit from checkpoints: checkpoint i holds the deposit of samples
   * [0, (i + 1) · spacing), so a scrub step copies the nearest one below the
   * cutoff and deposits at most `spacing` samples. Samples only ever append,
   * so checkpoints stay valid while a live job grows (until its grid changes).
   */
  private depositCoarse(store: SampleStore, setup: SimSetup, dst: Target, n: number): void {
    const gl = this.gl
    const { grid } = setup
    const whole = { x: 0, y: 0, width: grid.width, height: grid.height }
    const key = [grid.originXMm, grid.originYMm, grid.pitchMm, grid.width, grid.height, setup.material.absorption].join()
    if (!this.checkpoints || this.checkpoints.key !== key || this.checkpoints.store !== store) {
      this.dropCheckpoints()
      this.checkpoints = { key, store, spacing: CHECKPOINT_MIN_SPACING, targets: [] }
    }
    const cp = this.checkpoints
    while (store.count > cp.spacing * CHECKPOINT_MAX) {
      // Double the spacing: old checkpoint 2i + 1 is new checkpoint i.
      cp.targets.forEach((t, i) => {
        if (i % 2 === 0) {
          gl.deleteTexture(t.tex)
          gl.deleteFramebuffer(t.fbo)
        }
      })
      cp.targets = cp.targets.filter((_, i) => i % 2 === 1)
      cp.spacing *= 2
    }
    const copy = (src: Target, to: Target) => {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fbo)
      gl.blitFramebuffer(0, 0, grid.width, grid.height, 0, 0, grid.width, grid.height, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    }
    const j = Math.min(Math.floor(n / cp.spacing), CHECKPOINT_MAX)
    // Build every checkpoint the store allows up front, so drag steps cost the same at any cutoff.
    const available = Math.min(Math.floor(store.count / cp.spacing), CHECKPOINT_MAX)
    while (cp.targets.length < available) {
      const i = cp.targets.length
      const t = target(gl, gl.R32F, grid.width, grid.height)
      gl.disable(gl.BLEND)
      if (i > 0) copy(cp.targets[i - 1]!, t)
      else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      this.beginDeposit(setup, whole, t.fbo)
      this.drawSamples(this.sampleBuffer, i * cp.spacing, cp.spacing)
      cp.targets.push(t)
    }
    gl.disable(gl.BLEND)
    if (j > 0) copy(cp.targets[j - 1]!, dst)
    this.beginDeposit(setup, whole, dst.fbo)
    this.drawSamples(this.sampleBuffer, j * cp.spacing, n - j * cp.spacing)
  }

  private weights(k: Kernel1D): WebGLTexture {
    const key = `${k.sigmaCells}/${k.radius}`
    let t = this.weightTextures.get(key)
    if (!t) {
      const gl = this.gl
      t = texture(gl, gl.R32F, k.weights.length, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, k.weights.length, 1, gl.RED, gl.FLOAT, k.weights)
      this.weightTextures.set(key, t)
    }
    return t
  }

  /** Taps of a sheared Y pass as RGBA32F texels (w0, w1, x offset, 0). */
  private skewTaps(k: Kernel1D, skew: SkewTaps): WebGLTexture {
    const key = `skew/${k.sigmaCells}/${k.radius}/${skew.shear}`
    let t = this.weightTextures.get(key)
    if (!t) {
      const gl = this.gl
      const n = k.weights.length
      const texels = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        texels[i * 4] = skew.w0[i]!
        texels[i * 4 + 1] = skew.w1[i]!
        texels[i * 4 + 2] = skew.offset[i]!
      }
      t = texture(gl, gl.RGBA32F, n, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RGBA, gl.FLOAT, texels)
      this.weightTextures.set(key, t)
    }
    return t
  }

  /** Block until the GPU is done: finish plus a 1-pixel readback from `fbo` (default: the last run's fluence target). */
  sync(fbo: WebGLFramebuffer | null = this.lastFbo): void {
    const gl = this.gl
    gl.finish()
    if (fbo) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.readBuffer(gl.COLOR_ATTACHMENT0)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, this.syncPixel)
    }
  }

  /** Σ texels of `tex` over rect (J/mm² · cells), via GPU reduction. */
  private sumRect(tex: WebGLTexture, rect: CellRect): number {
    const gl = this.gl
    const r = this.reduce.use()
    gl.bindVertexArray(this.emptyVao)
    gl.disable(gl.BLEND)
    let src = tex
    let min: [number, number] = [rect.x, rect.y]
    let max: [number, number] = [rect.x + rect.width, rect.y + rect.height]
    let w = rect.width
    let h = rect.height
    let last: Target | null = null
    do {
      w = Math.ceil(w / REDUCE_FACTOR)
      h = Math.ceil(h / REDUCE_FACTOR)
      const key = `${w}x${h}`
      let t = this.reduceTargets.get(key)
      if (!t) {
        t = target(gl, gl.R32F, w, h)
        this.reduceTargets.set(key, t)
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
      gl.viewport(0, 0, w, h)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      r.i('u_src', 0).i('u_min', ...min).i('u_max', ...max)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      src = t.tex
      min = [0, 0]
      max = [w, h]
      last = t
    } while (w > 1 || h > 1)
    gl.bindFramebuffer(gl.FRAMEBUFFER, last.fbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    const px = new Float32Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px)
    return px[0]!
  }

  private readRect<T extends ArrayBufferView>(
    fbo: WebGLFramebuffer,
    rect: CellRect,
    format: number,
    type: number,
    channels: number,
    make: (n: number) => T,
    pick: (raw: T) => T,
  ): T {
    const gl = this.gl
    const raw = make(rect.width * rect.height * channels)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    gl.readPixels(rect.x, rect.y, rect.width, rect.height, format, type, raw)
    return pick(raw)
  }

  /** Full-resolution run over every tile of the plan. */
  run(store: SampleStore, setup: SimSetup, options: GlRunOptions = {}): GlRunResult {
    return this.runSetup(store, setup, 'full', options)
  }

  /** Coarse scrub preview at the cutoff (single tile, widened kernel). */
  runCoarse(store: SampleStore, full: SimSetup, timeCutoffS: number, options: Omit<GlRunOptions, 'timeCutoffS'> = {}): GlRunResult {
    return this.runSetup(store, coarseSetup(full), 'coarse', { ...options, timeCutoffS })
  }

  private runSetup(store: SampleStore, setup: SimSetup, poolKind: 'full' | 'coarse', options: GlRunOptions): GlRunResult {
    const gl = this.gl
    const { grid, plan, material, separable } = setup
    for (const t of plan.tiles)
      if (Math.max(t.padded.width, t.padded.height) > this.caps.maxTextureSize)
        throw new Error(`tile ${t.padded.width}×${t.padded.height} exceeds MAX_TEXTURE_SIZE ${this.caps.maxTextureSize}`)
    this.syncSamples(store)
    const n = store.countUntil(options.timeCutoffS ?? Infinity)
    const maxW = Math.max(...plan.tiles.map((t) => t.padded.width))
    const maxH = Math.max(...plan.tiles.map((t) => t.padded.height))
    const ts = this.pool(poolKind, maxW, maxH)
    const stageMs: Partial<Record<GlStage, number>> = {}
    const energy: StageEnergy | null = options.measureEnergy
      ? { expectedJ: store.energyOf(n) * material.absorption, depositJ: 0, blurHJ: 0, blurVJ: 0, clippedJ: 0 }
      : null
    const cellArea = grid.pitchMm * grid.pitchMm
    const timed = (stage: GlStage, fbo: WebGLFramebuffer, work: () => void) => {
      if (!options.syncStages) return work()
      const t0 = performance.now()
      work()
      this.sync(fbo)
      stageMs[stage] = (stageMs[stage] ?? 0) + performance.now() - t0
    }
    const wx = this.weights(separable.x)
    const wy = separable.skew ? this.skewTaps(separable.y, separable.skew) : this.weights(separable.y)
    const rp = responseParams(material)
    const vt = verdictThresholds(material.response)
    const fireAt = material.fireRisk.kind === 'fluence' ? material.fireRisk.thresholdJPerMm2 : FLT_BIG
    const finite = (v: number) => (Number.isFinite(v) ? v : FLT_BIG)

    for (const tile of plan.tiles) {
      const { padded, core } = tile
      const w = padded.width
      const h = padded.height
      const local = { x: core.x - padded.x, y: core.y - padded.y, width: core.width, height: core.height }

      timed('deposit', ts.a.fbo, () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, ts.a.fbo)
        gl.viewport(0, 0, ts.width, ts.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.viewport(0, 0, w, h)
        if (this.caps.floatBlend) {
          if (poolKind === 'coarse') this.depositCoarse(store, setup, ts.a, n)
          else {
            this.beginDeposit(setup, padded, ts.a.fbo)
            if (plan.tiles.length > 1) this.depositBinned(store, setup, padded, options.timeCutoffS ?? Infinity)
            else this.drawSamples(this.sampleBuffer, 0, n)
          }
          gl.disable(gl.BLEND)
        } else {
          const dep = depositCpu(store, n, grid, padded, material.absorption)
          gl.bindTexture(gl.TEXTURE_2D, ts.a.tex)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, dep.data)
        }
      })
      if (energy) energy.depositJ += this.sumRect(ts.a.tex, local) * cellArea

      gl.bindVertexArray(this.emptyVao)
      const pass = (src: Target, dst: Target, k: Kernel1D, weights: WebGLTexture, dir: [number, number]) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
        gl.viewport(0, 0, w, h)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, src.tex)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, weights)
        if (dir[1] === 1 && separable.skew) this.skewBlur.use().i('u_src', 0).i('u_taps', 1).i('u_radius', k.radius).i('u_size', w, h)
        else this.blur.use().i('u_src', 0).i('u_weights', 1).i('u_radius', k.radius).i('u_dir', ...dir).i('u_size', w, h)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      timed('blurH', ts.b.fbo, () => pass(ts.a, ts.b, separable.x, wx, [1, 0]))
      if (energy) energy.blurHJ += this.sumRect(ts.b.tex, local) * cellArea
      gl.bindVertexArray(this.emptyVao)
      timed('blurV', ts.a.fbo, () => pass(ts.b, ts.a, separable.y, wy, [0, 1]))
      if (energy) energy.blurVJ += this.sumRect(ts.a.tex, local) * cellArea
      gl.bindVertexArray(this.emptyVao)

      // finish() inside sync waits for the response pass; the readback just needs a float target.
      timed('response', ts.a.fbo, () => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, ts.responseFbo)
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2])
        gl.viewport(0, 0, w, h)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, ts.a.tex)
        this.response
          .use()
          .i('u_fluence', 0)
          .i('u_size', w, h)
          .f('u_colorA', rp.colorA.l, rp.colorA.a, rp.colorA.b)
          .f('u_colorB', rp.colorB.l, rp.colorB.a, rp.colorB.b)
          .f('u_rampStart', rp.rampStart)
          .f('u_rampEnd', rp.rampEnd)
          .f('u_gamma', rp.gamma)
          .f('u_depthThreshold', finite(rp.depthThreshold))
          .f('u_depthPerFluence', rp.depthPerFluence)
          .i('u_polishedEdge', rp.polishedEdge ? 1 : 0)
          .f('u_edgeMin', finite(rp.edgeMinFluence))
          .f('u_underBelow', vt.underBelow)
          .f('u_overAbove', vt.overAbove)
          .f('u_fireAt', fireAt)
          .f('u_untouchedFraction', UNTOUCHED_FRACTION)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      })

      if (options.overview) this.composite(options.overview, setup, tile, ts)
      if (options.onTile) {
        const read = this.readRect.bind(this)
        options.onTile({
          tile,
          setup,
          fluence: ts.a.tex,
          color: ts.color,
          depth: ts.depth,
          verdict: ts.verdict,
          readFluence: (r) =>
            read(ts.a.fbo, r, gl.RGBA, gl.FLOAT, 4, (k) => new Float32Array(k), (raw) => raw.filter((_, i) => i % 4 === 0)),
          readColor: (r) => read(ts.colorFbo, r, gl.RGBA, gl.UNSIGNED_BYTE, 4, (k) => new Uint8ClampedArray(k), (raw) => raw),
          readDepth: (r) =>
            read(ts.depthFbo, r, gl.RGBA, gl.FLOAT, 4, (k) => new Float32Array(k), (raw) => raw.filter((_, i) => i % 4 === 0)),
          readVerdict: (r) => {
            const raw = read(ts.verdictFbo, r, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 4, (k) => new Uint32Array(k), (x) => x)
            const out = new Uint8Array(r.width * r.height)
            for (let i = 0; i < out.length; i++) out[i] = raw[i * 4]!
            return out
          },
        })
      }
    }
    if (energy) energy.clippedJ = energy.expectedJ - energy.depositJ
    this.lastFbo = ts.a.fbo
    return { sampleCount: n, tileCount: plan.tiles.length, stageMs, energy, cpuDeposit: !this.caps.floatBlend }
  }

  private composite(ov: GlOverview, setup: SimSetup, tile: Tile, ts: TargetSet): void {
    const gl = this.gl
    const { grid } = setup
    ov.resize(grid.width, grid.height)
    const cpp = ov.cellsPerPixel
    const { core, padded } = tile
    // Overview pixels whose centre cell lies in this core.
    const px0 = Math.max(0, Math.ceil(core.x / cpp - 0.5))
    const px1 = Math.min(ov.width, Math.ceil((core.x + core.width) / cpp - 0.5))
    const py0 = Math.max(0, Math.ceil(core.y / cpp - 0.5))
    const py1 = Math.min(ov.height, Math.ceil((core.y + core.height) / cpp - 0.5))
    if (px1 <= px0 || py1 <= py0) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, ov.fbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    gl.viewport(0, 0, ov.width, ov.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(px0, py0, px1 - px0, py1 - py0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, ts.color)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, ts.verdict)
    gl.bindVertexArray(this.emptyVao)
    this.overviewProgram
      .use()
      .i('u_color', 0)
      .i('u_verdict', 1)
      .f('u_cellsPerPixel', cpp, cpp)
      .f('u_coreMin', core.x, core.y)
      .f('u_coreMax', core.x + core.width, core.y + core.height)
      .f('u_paddedOrigin', padded.x, padded.y)
      .i('u_taps', Math.min(16, Math.ceil(cpp)))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
  }
}

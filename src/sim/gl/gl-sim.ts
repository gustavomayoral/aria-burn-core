// SPDX-License-Identifier: MIT
// WebGL2 pipeline: deposit → blur H → blur V (sheared for rotated spots) → response, per tile, with
// render targets pooled across tiles and runs (COD-252: reallocating ~GBs of
// float targets per pass stalls the driver). Full-res and coarse runs keep
// separate pools so scrubbing never evicts the full-res targets.
//
// Requires EXT_color_buffer_float (R32F render targets). Without
// EXT_float_blend the deposit runs on the CPU (cpu.ts) and is uploaded.
//
// With a thermal model (COD-258) the thermal step runs first (gl-thermal.ts,
// or the CPU reference without EXT_float_blend) and the pipeline deposits
// each sample's dose energy instead: the R32F targets then hold thermal dose,
// and the response reads the bulk-temperature map for fire risk.

import type { CellRect, GridSpec, Tile, TilePlan } from '../../contract/index.ts'
import { TILE_MAX_CELLS, defaultGpuBudgetBytes, UNTOUCHED_FRACTION, tilePoolBytes, verdictThresholds } from '../../contract/index.ts'
import { depositCpu, type StageEnergy } from '../cpu.ts'
import { coarseSetup, type SimSetup } from '../job.ts'
import type { Kernel1D, SkewTaps } from '../kernel.ts'
import { responseParams } from '../response.ts'
import { SampleBins } from '../bins.ts'
import type { SampleStore } from '../sample-store.ts'
import { defaultThermalStep, peakTemperatureModel, thermalFor, type ThermalResult } from '../thermal.ts'
import { GlPeakTemperatureStep } from './gl-thermal.ts'
import { PER_SAMPLE_WIDTH } from './thermal-shaders.ts'
import { planSide, replan, shrinkSide, tileSide, withTileFallback } from '../tile-budget.ts'
import {
  GlAllocationError,
  GlContextLostError,
  Program,
  assertContext,
  deleteTexture,
  framebuffer,
  ledger,
  storage,
  target,
  texture,
  trackBuffer,
  type Target,
} from './gl-util.ts'
import {
  BLUR_FS,
  DEPOSIT_FS,
  DEPOSIT_THERMAL_VS,
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
  /**
   * Run only this rect of the job grid, as one tile (core = rect, padded by the
   * kernel margin), with the binned deposit: the zoomed burn view's 1:1 detail (COD-259).
   */
  region?: CellRect
}

export interface GlRunResult {
  sampleCount: number
  tileCount: number
  /** Per-stage wall time summed over tiles (ms); only with syncStages. */
  stageMs: Partial<Record<GlStage, number>>
  /** With a thermal model these are dose energies (J): Σ eDose expected, dose after each stage. */
  energy: StageEnergy | null
  cpuDeposit: boolean
  /** The thermal step's result when the material has a thermal model, else null. */
  thermal: ThermalResult | null
  /** The plan that ran: the setup's, or a smaller one when the byte budget or an allocation failure required it (BURN-36). */
  plan: TilePlan
  /** True when `plan` differs from the setup's (callers tracking dirty tiles should re-run everything). */
  replanned: boolean
  /** Tile sides that failed to allocate during this run, largest first. */
  failedSides: number[]
}

/** A finished tile's GPU outputs, valid only inside onTile. */
export interface GlTileView {
  tile: Tile
  setup: SimSetup
  /** What `fluence` holds: fluence, or thermal dose with a thermal model (COD-258). */
  quantity: 'fluence' | 'dose'
  /** The thermal result (peak temperature = ambient + flashK · dose, bulk map), or null. */
  thermal: ThermalResult | null
  /** Blurred fluence or dose (R32F), colour (RGBA8), depth (R32F), verdict (R8UI); padded-rect sized. */
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
/** Bin edge in cells for tiled deposit (tiles are at most TILE_MAX_CELLS = 9000, so ≤ ~18 bins across). */
const BIN_CELLS = 512
/** Coarse checkpoints: at most this many, at least this many samples apart. */
const CHECKPOINT_MAX = 16
const CHECKPOINT_MIN_SPACING = 1 << 16

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

  /** Allocates the whole pool or nothing: a refused target frees the ones already made. */
  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly width: number,
    readonly height: number,
  ) {
    const texs: WebGLTexture[] = []
    const fbos: WebGLFramebuffer[] = []
    const tex = (internal: number) => {
      const t = texture(gl, internal, width, height)
      texs.push(t)
      return t
    }
    const fb = (...ts: WebGLTexture[]) => {
      const f = framebuffer(gl, ...ts)
      fbos.push(f)
      return f
    }
    try {
      const aTex = tex(gl.R32F)
      this.a = { tex: aTex, fbo: fb(aTex) }
      const bTex = tex(gl.R32F)
      this.b = { tex: bTex, fbo: fb(bTex) }
      this.color = tex(gl.RGBA8)
      this.depth = tex(gl.R32F)
      this.verdict = tex(gl.R8UI)
      this.responseFbo = fb(this.color, this.depth, this.verdict)
      this.colorFbo = fb(this.color)
      this.depthFbo = fb(this.depth)
      this.verdictFbo = fb(this.verdict)
    } catch (e) {
      for (const t of texs) deleteTexture(gl, t)
      for (const f of fbos) gl.deleteFramebuffer(f)
      if (e instanceof GlAllocationError) throw new GlAllocationError(`tile pool ${width}×${height}: ${e.message}`, tilePoolBytes(width, height))
      throw e
    }
  }

  get bytes(): number {
    return tilePoolBytes(this.width, this.height)
  }

  dispose(): void {
    const gl = this.gl
    for (const t of [this.a.tex, this.b.tex, this.color, this.depth, this.verdict]) deleteTexture(gl, t)
    for (const f of [this.a.fbo, this.b.fbo, this.responseFbo, this.colorFbo, this.depthFbo, this.verdictFbo]) gl.deleteFramebuffer(f)
  }
}

/**
 * Tile sides learned per GPU (renderer string) after an allocation failed, so
 * a GlSim rebuilt after a context loss starts below the size that killed it.
 * Lives for the page; a reload starts from the budget again.
 */
const learnedTileSides = new Map<string, number>()

/** Mip levels for a full chain down to 1×1. */
export const mipLevels = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h, 1))) + 1

/**
 * The UI canvas source: job-wide colour, verdict and field at display resolution.
 * `field` (RGBA16F) holds the box-filtered fluence or dose (R) and depth in mm
 * (G); the burn view shades relief and halos from it (COD-259). Colour and
 * field are mipmapped so zoomed-out views don't alias.
 */
export class GlOverview {
  color: WebGLTexture | null = null
  verdict: WebGLTexture | null = null
  field: WebGLTexture | null = null
  /** Fraction of cells per verdict bucket [under, in range, over, fire risk] (RGBA16F), for the overlay's regions. */
  cover: WebGLTexture | null = null
  fbo: WebGLFramebuffer | null = null
  width = 0
  height = 0
  /** Job cells per overview pixel (same on both axes). */
  cellsPerPixel = 1
  /** The job grid last composited, so pixels map back to mm. */
  grid: GridSpec | null = null
  /** Bumped after every run that composited into it. */
  version = 0

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
    this.color = mipTexture(gl, gl.RGBA8, w, h)
    this.verdict = texture(gl, gl.R8UI, w, h)
    this.field = mipTexture(gl, gl.RGBA16F, w, h)
    this.cover = mipTexture(gl, gl.RGBA16F, w, h)
    this.fbo = framebuffer(gl, this.color, this.verdict, this.field, this.cover)
  }

  /** Mip chains of colour, field and cover, once all tiles are in. */
  finish(): void {
    if (!this.color || !this.field || !this.cover) return
    const gl = this.gl
    for (const t of [this.color, this.field, this.cover]) {
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    this.version++
  }

  dispose(): void {
    for (const t of [this.color, this.verdict, this.field, this.cover]) deleteTexture(this.gl, t)
    if (this.fbo) this.gl.deleteFramebuffer(this.fbo)
    this.color = this.verdict = this.field = this.cover = this.fbo = null
    this.width = this.height = 0
    this.grid = null
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

/** A texture with a full, trilinearly filtered mip chain (RGBA8, or RGBA16F: filterable without OES_texture_float_linear). */
export function mipTexture(gl: WebGL2RenderingContext, internal: number, w: number, h: number): WebGLTexture {
  const levels = mipLevels(w, h)
  const texel = internal === gl.RGBA16F ? 8 : 4
  let bytes = 0
  for (let l = 0; l < levels; l++) bytes += Math.max(1, w >> l) * Math.max(1, h >> l) * texel
  const t = storage(gl, levels, internal, w, h, bytes)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

/** One tile covering `rect` of the plan's grid, padded by the plan's margin. */
export function regionPlan(plan: TilePlan, rect: CellRect): TilePlan {
  const { grid, marginCells } = plan
  const x = Math.max(0, Math.min(grid.width - 1, Math.floor(rect.x)))
  const y = Math.max(0, Math.min(grid.height - 1, Math.floor(rect.y)))
  const core = {
    x,
    y,
    width: Math.max(1, Math.min(grid.width, Math.ceil(rect.x + rect.width)) - x),
    height: Math.max(1, Math.min(grid.height, Math.ceil(rect.y + rect.height)) - y),
  }
  const px = Math.max(0, core.x - marginCells)
  const py = Math.max(0, core.y - marginCells)
  const padded = {
    x: px,
    y: py,
    width: Math.min(grid.width, core.x + core.width + marginCells) - px,
    height: Math.min(grid.height, core.y + core.height + marginCells) - py,
  }
  return { grid, marginCells, cols: 1, rows: 1, tiles: [{ col: 0, row: 0, core, padded }] }
}

export class GlSim {
  readonly caps: GlCaps
  private readonly deposit: Program
  private readonly depositThermal: Program
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
  private readonly binIndexBuffer: WebGLBuffer
  /** The GPU thermal step; null without EXT_float_blend (the CPU reference runs instead). */
  readonly thermalStep: GlPeakTemperatureStep | null
  private thermalState: {
    result: ThermalResult
    id: number
    perSample: WebGLTexture
    ownsPerSample: boolean
    bulk: WebGLTexture | null
    ownsBulk: boolean
  } | null = null
  private thermalIds = 0
  /** Thermal state of the run in progress; deposits read dose energies when set. */
  private active: NonNullable<GlSim['thermalState']> | null = null
  /** Budget for everything a run keeps on the GPU (BURN-36). */
  readonly gpuBudgetBytes: number
  /** Largest tile side known to allocate on this GPU (shrinks after a failure). */
  maxTileSide: number
  private readonly failPoolAboveBytes: number
  /** Size of the last pool that failed to allocate, for the context-loss path. */
  private failedPoolBytes = 0

  /**
   * `forceCpuDeposit` exercises the no-EXT_float_blend fallback on hardware that has it.
   * `gpuBudgetBytes` overrides the contract's defaultGpuBudgetBytes(renderer); `maxTileSide` caps the tile side.
   * `failPoolAboveBytes` makes any tile pool larger than this fail as if the GPU refused it
   * (tests and bench exercise the smaller-tile fallback with it).
   */
  constructor(
    readonly gl: WebGL2RenderingContext,
    options: { forceCpuDeposit?: boolean; gpuBudgetBytes?: number; maxTileSide?: number; failPoolAboveBytes?: number } = {},
  ) {
    assertContext(gl)
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
    this.gpuBudgetBytes = options.gpuBudgetBytes ?? defaultGpuBudgetBytes(this.caps.renderer)
    this.maxTileSide = Math.min(options.maxTileSide ?? TILE_MAX_CELLS, learnedTileSides.get(this.caps.renderer) ?? TILE_MAX_CELLS)
    this.failPoolAboveBytes = options.failPoolAboveBytes ?? Infinity
    this.deposit = new Program(gl, DEPOSIT_VS, DEPOSIT_FS)
    this.depositThermal = new Program(gl, DEPOSIT_THERMAL_VS, DEPOSIT_FS)
    this.blur = new Program(gl, FULLSCREEN_VS, BLUR_FS)
    this.skewBlur = new Program(gl, FULLSCREEN_VS, SKEW_BLUR_FS)
    this.response = new Program(gl, FULLSCREEN_VS, RESPONSE_FS)
    this.reduce = new Program(gl, FULLSCREEN_VS, REDUCE_FS)
    this.overviewProgram = new Program(gl, FULLSCREEN_VS, OVERVIEW_FS)
    this.emptyVao = gl.createVertexArray()!
    this.sampleVao = gl.createVertexArray()!
    this.sampleBuffer = gl.createBuffer()!
    this.binBuffer = gl.createBuffer()!
    this.binIndexBuffer = gl.createBuffer()!
    gl.bindVertexArray(this.sampleVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.sampleBuffer)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0)
    gl.vertexAttribDivisor(0, 1)
    gl.bindVertexArray(null)
    // The thermal deposit's index attribute is an integer; its generic value must be one too.
    gl.vertexAttribI4ui(1, 0, 0, 0, 0)
    this.thermalStep = floatBlend ? new GlPeakTemperatureStep(gl, () => this.sampleBuffer) : null
  }

  /**
   * The thermal result for this store and setup (null without a thermal model),
   * with its per-sample energies and bulk map as textures. The result is
   * shared with the hover readout through the thermalFor cache.
   */
  thermal(store: SampleStore, setup: SimSetup): ThermalResult | null {
    return this.thermalTextures(store, setup)?.result ?? null
  }

  private thermalTextures(store: SampleStore, setup: SimSetup): NonNullable<GlSim['thermalState']> | null {
    if (!peakTemperatureModel(setup.material)) return null
    const gl = this.gl
    this.syncSamples(store)
    const step = setup.thermalStep ?? this.thermalStep ?? defaultThermalStep
    const result = thermalFor(store, setup.machine, setup.material, setup.thermalKernel, step)!
    const t = this.thermalState
    // Textures borrowed from the GPU step die with its next run.
    if (t?.result === result && (t.ownsPerSample || this.thermalStep?.current === result)) return t
    this.dropThermal()
    let perSample: WebGLTexture
    let ownsPerSample = false
    if (this.thermalStep && this.thermalStep.current === result) perSample = this.thermalStep.current.perSample
    else {
      // A CPU (or other) step's result: upload its energies in the GPU step's layout.
      const rows = Math.max(1, Math.ceil(result.count / PER_SAMPLE_WIDTH))
      const texels = new Float32Array(PER_SAMPLE_WIDTH * rows * 2)
      for (let i = 0; i < result.count; i++) {
        texels[i * 2] = result.eAbs[i]!
        texels[i * 2 + 1] = result.eDose[i]!
      }
      perSample = texture(gl, gl.RG32F, PER_SAMPLE_WIDTH, rows)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PER_SAMPLE_WIDTH, rows, gl.RG, gl.FLOAT, texels)
      ownsPerSample = true
    }
    let bulk: WebGLTexture | null = null
    let ownsBulk = false
    if (perSample === this.thermalStep?.current?.perSample) bulk = this.thermalStep.current.bulk
    else if (result.bulkK && result.plan) {
      ownsBulk = true
      const { width, height } = result.plan.grid
      bulk = texture(gl, gl.R32F, width, height)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, result.bulkK)
    }
    this.thermalState = { result, id: ++this.thermalIds, perSample, ownsPerSample, bulk, ownsBulk }
    return this.thermalState
  }

  private dropThermal(): void {
    const t = this.thermalState
    if (!t) return
    if (t.ownsPerSample) deleteTexture(this.gl, t.perSample)
    if (t.ownsBulk) deleteTexture(this.gl, t.bulk)
    this.thermalState = null
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
      trackBuffer(gl, this.sampleBuffer, this.sampleCapacity * 12)
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
    this.pools.delete(kind)
    if (cur && this.lastFbo === cur.a.fbo) this.lastFbo = null
    const pw = Math.max(w, cur?.width ?? 0)
    const ph = Math.max(h, cur?.height ?? 0)
    if (tilePoolBytes(pw, ph) > this.failPoolAboveBytes)
      throw new GlAllocationError(`tile pool ${pw}×${ph}: refused by failPoolAboveBytes`, tilePoolBytes(pw, ph))
    let next: TargetSet
    try {
      next = new TargetSet(this.gl, pw, ph)
    } catch (e) {
      this.failedPoolBytes = tilePoolBytes(pw, ph)
      throw e
    }
    this.pools.set(kind, next)
    return next
  }

  /**
   * Padded tile side that fits the byte budget next to everything else on the
   * GPU now (overviews and burn views on this context included), within the
   * device caps and any side learned from a failure. Pass the store about to
   * run so its sample and bin buffers are counted before they're uploaded.
   * Plan with it (setupJob / LiveJob.setup maxTileCells) so the run doesn't
   * have to replan.
   */
  tileSide(store?: SampleStore): number {
    const full = this.pools.get('full')
    let other = ledger(this.gl).total - (full?.bytes ?? 0)
    if (store) {
      if (this.uploadedStore !== store) other += Math.max(0, store.count * 12 - this.sampleCapacity * 12)
      if (this.binStore !== store) other += store.count * 16
    }
    return tileSide({ budgetBytes: this.gpuBudgetBytes, otherBytes: other, maxSide: Math.min(this.maxTileSide, this.caps.maxTextureSize) })
  }

  /**
   * Allocate what a full run needs besides the tile pool, so the budget sees
   * it, and return the tile side left: samples, the thermal step's textures
   * (per-sample energies are 8 B a sample) and, whenever the job could be
   * more than one tile, the spatial bins.
   */
  private prepare(store: SampleStore, setup: SimSetup, overview?: GlOverview): number {
    overview?.resize(setup.grid.width, setup.grid.height)
    this.syncSamples(store)
    this.thermalTextures(store, setup)
    const { width, height } = setup.grid
    if (setup.plan.tiles.length > 1 || Math.max(width, height) > this.tileSide()) this.ensureBins(store, setup)
    return this.tileSide(store)
  }

  /**
   * The setup with a plan that fits this GPU's budget now (BURN-36): the same
   * setup if it already fits, else one replanned (regular or live lattice)
   * with smaller tiles. Plan with this before a full run so the run doesn't
   * replan under you (e.g. when tracking a live job's dirty tiles). Pass the
   * overview the run will composite into so it is counted too.
   */
  fit(store: SampleStore, setup: SimSetup, overview?: GlOverview): SimSetup {
    const side = this.prepare(store, setup, overview)
    return planSide(setup.plan) <= side ? setup : { ...setup, plan: replan(setup, side) }
  }

  /**
   * Bench probe (BURN-36): allocate one full tile pool of side × side and keep
   * it, as a run would. Throws GlAllocationError if the GPU refuses it and
   * GlContextLostError if the context died.
   */
  probePool(side: number): number {
    this.pools.get('full')?.dispose()
    this.pools.delete('full')
    this.lastFbo = null
    const ts = this.pool('full', side, side)
    this.sync(ts.a.fbo)
    assertContext(this.gl)
    return ts.bytes
  }

  /** Drop pooled targets, coarse checkpoints and bins (e.g. after a large job closes). */
  releaseTargets(): void {
    for (const t of this.pools.values()) t.dispose()
    this.pools.clear()
    // sync() reads back from the last run's target, which was just deleted.
    this.lastFbo = null
    this.dropCheckpoints()
    this.dropThermal()
    this.thermalStep?.release()
    this.bins = this.binStore = null
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.binBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.binIndexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW)
    trackBuffer(gl, this.binBuffer, 0)
    trackBuffer(gl, this.binIndexBuffer, 0)
  }

  private dropCheckpoints(): void {
    for (const t of this.checkpoints?.targets ?? []) {
      deleteTexture(this.gl, t.tex)
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
    const inv2 = 1 / (grid.pitchMm * grid.pitchMm)
    const program = this.active ? this.depositThermal : this.deposit
    program
      .use()
      .f('u_origin', grid.originXMm, grid.originYMm)
      .f('u_invPitch', 1 / grid.pitchMm)
      .f('u_rectOffset', rect.x, rect.y)
      .f('u_size', rect.width, rect.height)
      .f('u_scale', this.active ? inv2 : material.absorption * inv2)
    if (this.active) {
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, this.active.perSample)
      program.i('u_perSample', 3)
    }
  }

  /**
   * Draw samples [first, first + count) of `buffer` (interleaved xye) as deposit
   * points. `binned` draws from the bin buffer, whose store indices are in binIndexBuffer.
   */
  private drawSamples(buffer: WebGLBuffer, first: number, count: number, binned = false): void {
    if (count <= 0) return
    const gl = this.gl
    gl.bindVertexArray(this.sampleVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, first * 12)
    if (this.active) {
      this.depositThermal.i('u_first', first).i('u_binned', binned ? 1 : 0)
      if (binned) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.binIndexBuffer)
        gl.enableVertexAttribArray(1)
        gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 4, first * 4)
        gl.vertexAttribDivisor(1, 1)
      } else gl.disableVertexAttribArray(1)
    }
    gl.drawArraysInstanced(gl.POINTS, 0, 4, count)
    if (this.active && binned) gl.disableVertexAttribArray(1)
  }

  /** Spatial bins of the store for this grid's pitch, uploaded (rebuilt when the store or pitch changed). */
  private ensureBins(store: SampleStore, setup: SimSetup): SampleBins {
    const gl = this.gl
    const bucketMm = BIN_CELLS * setup.grid.pitchMm
    if (!this.bins || this.binStore !== store || this.bins.version !== store.version || this.bins.bucketMm !== bucketMm) {
      this.bins = new SampleBins(store, bucketMm)
      this.binStore = store
      gl.bindBuffer(gl.ARRAY_BUFFER, this.binBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.bins.xye, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.binIndexBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, this.bins.index, gl.STATIC_DRAW)
      trackBuffer(gl, this.binBuffer, this.bins.xye.byteLength)
      trackBuffer(gl, this.binIndexBuffer, this.bins.index.byteLength)
    }
    return this.bins
  }

  /** Multi-tile deposit: only the bins that can reach this tile's padded rect. */
  private depositBinned(store: SampleStore, setup: SimSetup, padded: CellRect, cutoffS: number): void {
    const { grid } = setup
    const bins = this.ensureBins(store, setup)
    // One cell of slack for the bilinear footprint; anything else off the rect is clipped.
    const x0 = grid.originXMm + (padded.x - 1) * grid.pitchMm
    const y0 = grid.originYMm + (padded.y - 1) * grid.pitchMm
    const x1 = grid.originXMm + (padded.x + padded.width + 1) * grid.pitchMm
    const y1 = grid.originYMm + (padded.y + padded.height + 1) * grid.pitchMm
    for (const [first, count] of bins.ranges(x0, y0, x1, y1, cutoffS)) this.drawSamples(this.binBuffer, first, count, true)
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
    const key = [grid.originXMm, grid.originYMm, grid.pitchMm, grid.width, grid.height, setup.material.absorption, this.active?.id ?? 0].join()
    if (!this.checkpoints || this.checkpoints.key !== key || this.checkpoints.store !== store) {
      this.dropCheckpoints()
      this.checkpoints = { key, store, spacing: CHECKPOINT_MIN_SPACING, targets: [] }
    }
    const cp = this.checkpoints
    while (store.count > cp.spacing * CHECKPOINT_MAX) {
      // Double the spacing: old checkpoint 2i + 1 is new checkpoint i.
      cp.targets.forEach((t, i) => {
        if (i % 2 === 0) {
          deleteTexture(gl, t.tex)
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

  /**
   * Budget the tiles, then run (BURN-36). A full run whose tiles exceed
   * tileSide() is replanned smaller up front; if a pool still fails to
   * allocate, it retries with smaller tiles. Coarse and region runs are one
   * tile each and have nothing to shrink, so their failures propagate.
   */
  private runSetup(store: SampleStore, setup: SimSetup, poolKind: 'full' | 'coarse', options: GlRunOptions): GlRunResult {
    assertContext(this.gl)
    if (poolKind === 'coarse' || options.region) {
      const plan = options.region ? regionPlan(setup.plan, options.region) : setup.plan
      return this.guard(() => this.runPlan(store, setup, plan, poolKind, options))
    }
    const budgetSide = this.prepare(store, setup, options.overview)
    const fits = planSide(setup.plan) <= budgetSide
    const start = fits ? planSide(setup.plan) : budgetSide
    const { result, side, failed } = this.guard(() =>
      withTileFallback(
        start,
        (s) => {
          const plan = s === start && fits ? setup.plan : replan(setup, s)
          return this.runPlan(store, setup, plan, poolKind, options)
        },
        (e) => {
          if (!(e instanceof GlAllocationError) || this.gl.isContextLost()) return false
          this.active = null
          return true
        },
      ),
    )
    if (failed.length) {
      // Remember the side that worked for this GPU, here and for a GlSim rebuilt after a context loss.
      this.maxTileSide = Math.min(this.maxTileSide, side)
      this.learn()
    }
    return { ...result, replanned: result.plan !== setup.plan, failedSides: failed }
  }

  /** Share the learned side with GlSims rebuilt on this GPU; simulated failures (failPoolAboveBytes) teach nothing. */
  private learn(): void {
    if (this.failPoolAboveBytes === Infinity) learnedTileSides.set(this.caps.renderer, this.maxTileSide)
  }

  /**
   * Run, turning a context lost mid-run into GlContextLostError. If an
   * allocation failure took the context with it, the side that failed is
   * remembered so the GlSim rebuilt on the restored context starts smaller.
   */
  private guard<T>(fn: () => T): T {
    this.failedPoolBytes = 0
    try {
      return fn()
    } catch (e) {
      this.active = null
      if (this.gl.isContextLost()) {
        if (this.failedPoolBytes > 0) {
          const side = Math.floor(Math.sqrt(this.failedPoolBytes / tilePoolBytes(1, 1)))
          this.failedPoolBytes = 0
          if (side > 0) {
            this.maxTileSide = Math.min(this.maxTileSide, shrinkSide(side))
            this.learn()
          }
        }
        throw e instanceof GlContextLostError ? e : new GlContextLostError(`WebGL context lost: ${String(e)}`)
      }
      throw e
    }
  }

  private runPlan(store: SampleStore, setup: SimSetup, plan: TilePlan, poolKind: 'full' | 'coarse', options: GlRunOptions): GlRunResult {
    const gl = this.gl
    const { grid, material, separable } = setup
    // A region is a small window of a possibly huge job: draw only the bins that reach it.
    const binned = plan.tiles.length > 1 || !!options.region
    for (const t of plan.tiles)
      if (Math.max(t.padded.width, t.padded.height) > this.caps.maxTextureSize)
        throw new Error(`tile ${t.padded.width}×${t.padded.height} exceeds MAX_TEXTURE_SIZE ${this.caps.maxTextureSize}`)
    this.syncSamples(store)
    const n = store.countUntil(options.timeCutoffS ?? Infinity)
    const th = this.thermalTextures(store, setup)
    this.active = this.caps.floatBlend ? th : null
    const maxW = Math.max(...plan.tiles.map((t) => t.padded.width))
    const maxH = Math.max(...plan.tiles.map((t) => t.padded.height))
    const ts = this.pool(poolKind, maxW, maxH)
    const stageMs: Partial<Record<GlStage, number>> = {}
    let expectedJ = 0
    if (options.measureEnergy) {
      if (th) for (let i = 0; i < n; i++) expectedJ += th.result.eDose[i]!
      else expectedJ = store.energyOf(n) * material.absorption
    }
    const energy: StageEnergy | null = options.measureEnergy ? { expectedJ, depositJ: 0, blurHJ: 0, blurVJ: 0, clippedJ: 0 } : null
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
            if (binned) this.depositBinned(store, setup, padded, options.timeCutoffS ?? Infinity)
            else this.drawSamples(this.sampleBuffer, 0, n)
          }
          gl.disable(gl.BLEND)
        } else {
          const dep = depositCpu(store, n, grid, padded, material.absorption, th?.result.eDose ?? null)
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
        const bulkPlan = th?.result.plan ?? null
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, th?.bulk ?? null)
        const tileOrigin = { x: grid.originXMm + padded.x * grid.pitchMm, y: grid.originYMm + padded.y * grid.pitchMm }
        this.response
          .use()
          .i('u_thermal', th?.bulk && bulkPlan ? 1 : 0)
          .i('u_bulk', 1)
          .f('u_cellOriginMm', tileOrigin.x, tileOrigin.y)
          .f('u_pitchMm', grid.pitchMm)
          .f('u_bulkOriginMm', bulkPlan?.grid.originXMm ?? 0, bulkPlan?.grid.originYMm ?? 0)
          .f('u_bulkInvPitch', bulkPlan ? 1 / bulkPlan.grid.pitchMm : 0)
          .i('u_bulkSize', bulkPlan?.grid.width ?? 0, bulkPlan?.grid.height ?? 0)
          .f('u_ambientK', th?.result.ambientK ?? 0)
          .f('u_fireK', material.fireRisk.kind === 'temperature' ? material.fireRisk.thresholdK : FLT_BIG)
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
          quantity: th ? 'dose' : 'fluence',
          thermal: th?.result ?? null,
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
    options.overview?.finish()
    this.lastFbo = ts.a.fbo
    this.active = null
    assertContext(gl)
    return {
      sampleCount: n,
      tileCount: plan.tiles.length,
      stageMs,
      energy,
      cpuDeposit: !this.caps.floatBlend,
      thermal: th?.result ?? null,
      plan,
      replanned: false,
      failedSides: [],
    }
  }

  private composite(ov: GlOverview, setup: SimSetup, tile: Tile, ts: TargetSet): void {
    const gl = this.gl
    const { grid } = setup
    ov.resize(grid.width, grid.height)
    ov.grid = grid
    const cpp = ov.cellsPerPixel
    const { core, padded } = tile
    // Overview pixels whose centre cell lies in this core.
    const px0 = Math.max(0, Math.ceil(core.x / cpp - 0.5))
    const px1 = Math.min(ov.width, Math.ceil((core.x + core.width) / cpp - 0.5))
    const py0 = Math.max(0, Math.ceil(core.y / cpp - 0.5))
    const py1 = Math.min(ov.height, Math.ceil((core.y + core.height) / cpp - 0.5))
    if (px1 <= px0 || py1 <= py0) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, ov.fbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3])
    gl.viewport(0, 0, ov.width, ov.height)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(px0, py0, px1 - px0, py1 - py0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, ts.color)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, ts.verdict)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, ts.a.tex)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, ts.depth)
    gl.bindVertexArray(this.emptyVao)
    this.overviewProgram
      .use()
      .i('u_color', 0)
      .i('u_verdict', 1)
      .i('u_fluence', 2)
      .i('u_depth', 3)
      .f('u_cellsPerPixel', cpp, cpp)
      .f('u_coreMin', core.x, core.y)
      .f('u_coreMax', core.x + core.width, core.y + core.height)
      .f('u_paddedOrigin', padded.x, padded.y)
      .i('u_taps', Math.min(16, Math.ceil(cpp)))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.disable(gl.SCISSOR_TEST)
  }
}

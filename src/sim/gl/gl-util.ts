// SPDX-License-Identifier: MIT
// Small WebGL2 helpers shared by the pipeline (gl-sim.ts) and the thermal step (gl-thermal.ts).

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    // On a context that died but isn't flagged yet, compiles fail with an empty log (BURN-36, WebView2).
    if (contextGone(gl)) throw new GlContextLostError('WebGL context lost (shader compile failed)')
    throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`)
  }
  return s
}

export class Program {
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
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (contextGone(gl)) throw new GlContextLostError('WebGL context lost (program link failed)')
      throw new Error(`program link: ${gl.getProgramInfoLog(p)}`)
    }
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
  /** Last value set per uniform: programs keep their uniforms, so unchanged ones are skipped. */
  private readonly values = new Map<string, number[]>()
  private same(name: string, v: number[]): boolean {
    const last = this.values.get(name)
    if (last && last.length === v.length && last.every((x, i) => x === v[i])) return true
    this.values.set(name, v)
    return false
  }
  f(name: string, ...v: number[]): this {
    if (this.same(name, v)) return this
    const l = this.loc(name)
    if (v.length === 1) this.gl.uniform1f(l, v[0]!)
    else if (v.length === 2) this.gl.uniform2f(l, v[0]!, v[1]!)
    else if (v.length === 3) this.gl.uniform3f(l, v[0]!, v[1]!, v[2]!)
    else this.gl.uniform4f(l, v[0]!, v[1]!, v[2]!, v[3]!)
    return this
  }
  i(name: string, ...v: number[]): this {
    if (this.same(name, v)) return this
    const l = this.loc(name)
    if (v.length === 1) this.gl.uniform1i(l, v[0]!)
    else this.gl.uniform2i(l, v[0]!, v[1]!)
    return this
  }
  i4(name: string, ...v: [number, number, number, number]): this {
    if (this.same(name, v)) return this
    this.gl.uniform4i(this.loc(name), v[0], v[1], v[2], v[3])
    return this
  }
}

export interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
}

/**
 * An allocation the GPU refused: FRAMEBUFFER_UNSUPPORTED on a new render
 * target, or OUT_OF_MEMORY from texStorage2D (BURN-36). The caller can retry
 * smaller; partial allocations have been freed.
 */
export class GlAllocationError extends Error {
  constructor(
    message: string,
    /** Bytes the failed allocation asked for (0 when unknown). */
    readonly bytes = 0,
  ) {
    super(message)
    this.name = 'GlAllocationError'
  }
}

/** The WebGL context is lost; nothing on this context works until it is restored and rebuilt. */
export class GlContextLostError extends Error {
  constructor(message = 'WebGL context lost') {
    super(message)
    this.name = 'GlContextLostError'
  }
}

/** Throw GlContextLostError if the context is gone (calls on a lost context fail silently). */
export function assertContext(gl: WebGL2RenderingContext): void {
  if (gl.isContextLost()) throw new GlContextLostError()
}

const GL_CONTEXT_LOST_WEBGL = 0x9242

/**
 * Whether the context is gone, for use after something already failed.
 * isContextLost() only turns true once the browser has processed the loss,
 * which can be after the failing call (BURN-36: WebView2 reported 0x8cdd
 * first). finish() makes the loss surface, and getError() then reports
 * CONTEXT_LOST_WEBGL. Both are sync points and getError clears the error
 * flag, so only call this on a failure path.
 */
export function contextGone(gl: WebGL2RenderingContext): boolean {
  if (gl.isContextLost()) return true
  gl.finish()
  return gl.getError() === GL_CONTEXT_LOST_WEBGL || gl.isContextLost()
}

const GL_R8UI = 0x8232
const GL_R32F = 0x822e
const GL_RG32F = 0x8230
const GL_RGBA32F = 0x8814
const GL_RGBA16F = 0x881a
const GL_RGBA8 = 0x8058
const GL_OUT_OF_MEMORY = 0x0505
const GL_FRAMEBUFFER_UNSUPPORTED = 0x8cdd

/** Bytes per texel for the internal formats the pipeline uses. */
export function bytesPerTexel(internal: number): number {
  switch (internal) {
    case GL_R8UI:
      return 1
    case GL_R32F:
    case GL_RGBA8:
      return 4
    case GL_RG32F:
    case GL_RGBA16F:
      return 8
    case GL_RGBA32F:
      return 16
    default:
      return 4
  }
}

/**
 * What this context holds on the GPU, as the helpers below allocated it:
 * textures from texture()/mipTexture() and buffers registered with
 * trackBuffer(). The tile budget (BURN-36) subtracts it from the device budget.
 */
export class GpuLedger {
  private readonly sizes = new Map<object, number>()
  total = 0
  set(obj: object, bytes: number): void {
    this.total += bytes - (this.sizes.get(obj) ?? 0)
    if (bytes > 0) this.sizes.set(obj, bytes)
    else this.sizes.delete(obj)
  }
  bytesOf(obj: object | null | undefined): number {
    return obj ? (this.sizes.get(obj) ?? 0) : 0
  }
}

const ledgers = new WeakMap<WebGL2RenderingContext, GpuLedger>()
export function ledger(gl: WebGL2RenderingContext): GpuLedger {
  let l = ledgers.get(gl)
  if (!l) ledgers.set(gl, (l = new GpuLedger()))
  return l
}

/** Record a buffer's size after bufferData (0 when emptied). */
export function trackBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer, bytes: number): void {
  ledger(gl).set(buffer, bytes)
}

/** Delete a texture made by texture()/mipTexture() and drop it from the ledger. */
export function deleteTexture(gl: WebGL2RenderingContext, t: WebGLTexture | null | undefined): void {
  if (!t) return
  ledger(gl).set(t, 0)
  gl.deleteTexture(t)
}

/** Allocate immutable storage, turning OUT_OF_MEMORY into GlAllocationError. */
export function storage(gl: WebGL2RenderingContext, levels: number, internal: number, w: number, h: number, bytes: number): WebGLTexture {
  assertContext(gl)
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h)
  const err = gl.getError()
  if (err === GL_CONTEXT_LOST_WEBGL || gl.isContextLost()) throw new GlContextLostError(`WebGL context lost allocating a ${w}×${h} texture`)
  if (err === GL_OUT_OF_MEMORY) {
    gl.deleteTexture(t)
    if (contextGone(gl)) throw new GlContextLostError(`WebGL context lost allocating a ${w}×${h} texture`)
    throw new GlAllocationError(`out of memory allocating ${w}×${h} texture`, bytes)
  }
  ledger(gl).set(t, bytes)
  return t
}

export function texture(gl: WebGL2RenderingContext, internal: number, w: number, h: number): WebGLTexture {
  const t = storage(gl, 1, internal, w, h, w * h * bytesPerTexel(internal))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

export function framebuffer(gl: WebGL2RenderingContext, ...attachments: WebGLTexture[]): WebGLFramebuffer {
  assertContext(gl)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  attachments.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0))
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    const msg = `framebuffer incomplete: 0x${status.toString(16)}`
    // ANGLE/D3D11 also reports UNSUPPORTED when the device was reset; that's a lost context, not a size limit.
    if (contextGone(gl)) throw new GlContextLostError(`WebGL context lost (${msg})`)
    // Unsupported here means the driver refused the size (Iris Xe, BURN-33); anything else is a bug.
    if (status === GL_FRAMEBUFFER_UNSUPPORTED) throw new GlAllocationError(msg)
    throw new Error(msg)
  }
  return fbo
}

export function target(gl: WebGL2RenderingContext, internal: number, w: number, h: number): Target {
  const tex = texture(gl, internal, w, h)
  try {
    return { tex, fbo: framebuffer(gl, tex) }
  } catch (e) {
    deleteTexture(gl, tex)
    throw e
  }
}

// SPDX-License-Identifier: MIT
// Small WebGL2 helpers shared by the pipeline (gl-sim.ts) and the thermal step (gl-thermal.ts).

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader compile: ${gl.getShaderInfoLog(s)}`)
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

export function texture(gl: WebGL2RenderingContext, internal: number, w: number, h: number): WebGLTexture {
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

export function framebuffer(gl: WebGL2RenderingContext, ...attachments: WebGLTexture[]): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  attachments.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0))
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`)
  return fbo
}

export function target(gl: WebGL2RenderingContext, internal: number, w: number, h: number): Target {
  const tex = texture(gl, internal, w, h)
  return { tex, fbo: framebuffer(gl, tex) }
}

// SPDX-License-Identifier: MIT
// GLSL ES 3.00 for the WebGL2 pipeline. Each stage mirrors the CPU reference
// (cpu.ts, response.ts); keep them in step.

import { PER_SAMPLE_WIDTH } from './thermal-shaders.ts'

/** Fullscreen triangle; fragment stages work in texel coordinates via gl_FragCoord. */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/**
 * Deposit: one instance per sample, four 1-pixel points per instance, one per
 * bilinear neighbour, each placed exactly on its cell centre and carrying its
 * weight. Points off the viewport are clipped, which is the CPU's
 * keep-only-inside-the-rect rule. Additive blending into R32F (EXT_float_blend).
 */
export const DEPOSIT_VS = `#version 300 es
layout(location = 0) in vec3 a_xye;
uniform vec2 u_origin;
uniform float u_invPitch;
uniform vec2 u_rectOffset;
uniform vec2 u_size;
uniform float u_scale;
out float v_f;
void main() {
  vec2 f = (a_xye.xy - u_origin) * u_invPitch - 0.5;
  vec2 i0 = floor(f);
  vec2 a = f - i0;
  vec2 d = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 w = mix(1.0 - a, a, d);
  v_f = w.x * w.y * a_xye.z * u_scale;
  vec2 cell = i0 + d - u_rectOffset;
  gl_Position = vec4((cell + 0.5) / u_size * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`

/**
 * Thermal deposit (COD-258): as DEPOSIT_VS, but the energy is the sample's
 * dose energy from the thermal step's per-sample texture, looked up by store
 * index (u_first + instance, or the bin buffer's index attribute).
 */
export const DEPOSIT_THERMAL_VS = `#version 300 es
precision highp int;
layout(location = 0) in vec3 a_xye;
layout(location = 1) in uint a_index;
uniform highp sampler2D u_perSample;
uniform bool u_binned;
uniform int u_first;
uniform vec2 u_origin;
uniform float u_invPitch;
uniform vec2 u_rectOffset;
uniform vec2 u_size;
uniform float u_scale;
out float v_f;
void main() {
  int i = u_binned ? int(a_index) : u_first + gl_InstanceID;
  float e = texelFetch(u_perSample, ivec2(i % ${PER_SAMPLE_WIDTH}, i / ${PER_SAMPLE_WIDTH}), 0).g;
  vec2 f = (a_xye.xy - u_origin) * u_invPitch - 0.5;
  vec2 i0 = floor(f);
  vec2 a = f - i0;
  vec2 d = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 w = mix(1.0 - a, a, d);
  v_f = w.x * w.y * e * u_scale;
  vec2 cell = i0 + d - u_rectOffset;
  gl_Position = vec4((cell + 0.5) / u_size * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`

export const DEPOSIT_FS = `#version 300 es
precision highp float;
in float v_f;
out vec4 o;
void main() { o = vec4(v_f, 0.0, 0.0, 0.0); }`

/** One separable pass, zero outside u_size (the tile's padded rect). */
export const BLUR_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform highp sampler2D u_weights;
uniform int u_radius;
uniform ivec2 u_dir;
uniform ivec2 u_size;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int t = -u_radius; t <= u_radius; t++) {
    ivec2 q = p + u_dir * t;
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, u_size))) continue;
    acc += texelFetch(u_src, q, 0).r * texelFetch(u_weights, ivec2(t + u_radius, 0), 0).r;
  }
  o = vec4(acc, 0.0, 0.0, 0.0);
}`

/**
 * The sheared Y pass of a rotated kernel (kernel.ts SkewTaps). u_taps texel t
 * holds (w0, w1, x offset): row offset t reads x + offset and the cell after.
 * Same summation order as cpu.ts skewPass.
 */
export const SKEW_BLUR_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform highp sampler2D u_taps;
uniform int u_radius;
uniform ivec2 u_size;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int t = -u_radius; t <= u_radius; t++) {
    int y = p.y + t;
    if (y < 0 || y >= u_size.y) continue;
    vec4 tap = texelFetch(u_taps, ivec2(t + u_radius, 0), 0);
    int x = p.x + int(tap.b);
    if (x >= 0 && x < u_size.x) acc += texelFetch(u_src, ivec2(x, y), 0).r * tap.r;
    if (x + 1 >= 0 && x + 1 < u_size.x) acc += texelFetch(u_src, ivec2(x + 1, y), 0).r * tap.g;
  }
  o = vec4(acc, 0.0, 0.0, 0.0);
}`

/**
 * Response kinds → colour (sRGB8), depth (mm), verdict bucket. MRT. With
 * u_thermal the input is thermal dose and fire risk also reads the bulk map
 * (thermal grid, K above ambient) at the cell centre.
 */
export const RESPONSE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_fluence;
uniform ivec2 u_size;
uniform vec3 u_colorA;
uniform vec3 u_colorB;
uniform float u_rampStart;
uniform float u_rampEnd;
uniform float u_gamma;
uniform float u_depthThreshold;
uniform float u_depthPerFluence;
uniform bool u_polishedEdge;
uniform float u_edgeMin;
uniform float u_underBelow;
uniform float u_overAbove;
uniform float u_fireAt;
uniform float u_untouchedFraction;
uniform bool u_thermal;
uniform highp sampler2D u_bulk;
uniform vec2 u_cellOriginMm;
uniform float u_pitchMm;
uniform vec2 u_bulkOriginMm;
uniform float u_bulkInvPitch;
uniform ivec2 u_bulkSize;
uniform float u_ambientK;
uniform float u_fireK;
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_depth;
layout(location = 2) out uvec4 o_verdict;

float at(ivec2 q) {
  if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, u_size))) return 0.0;
  return texelFetch(u_fluence, q, 0).r;
}
float finv(float t) { return t > 6.0 / 29.0 ? t * t * t : 3.0 * (6.0 / 29.0) * (6.0 / 29.0) * (t - 4.0 / 29.0); }
float enc(float c) {
  float v = clamp(c, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
vec3 labToSrgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  float fx = fy + lab.y / 500.0;
  float fz = fy - lab.z / 200.0;
  vec3 xyz = vec3(0.95047 * finv(fx), finv(fy), 1.08883 * finv(fz));
  vec3 rgb = vec3(
    3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z,
    -0.969266 * xyz.x + 1.8760108 * xyz.y + 0.041556 * xyz.z,
    0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z);
  return vec3(enc(rgb.r), enc(rgb.g), enc(rgb.b));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float f = at(p);
  bool polished = u_polishedEdge && f < u_depthThreshold && f >= u_edgeMin &&
    max(max(at(p + ivec2(-1, 0)), at(p + ivec2(1, 0))), max(at(p + ivec2(0, -1)), at(p + ivec2(0, 1)))) >= u_depthThreshold;
  float span = u_rampEnd - u_rampStart;
  float t = span > 0.0 ? (f - u_rampStart) / span : (f >= u_rampStart ? 1.0 : 0.0);
  t = clamp(t, 0.0, 1.0);
  if (u_gamma != 1.0) t = pow(t, u_gamma);
  vec3 lab = polished ? u_colorA : mix(u_colorA, u_colorB, t);
  // Round like the CPU (Math.round of 255·v); the RGBA8 store truncates otherwise unpredictably.
  o_color = vec4(floor(labToSrgb(lab) * 255.0 + 0.5) / 255.0, 1.0);
  o_depth = vec4(f > u_depthThreshold ? (f - u_depthThreshold) * u_depthPerFluence : 0.0, 0.0, 0.0, 0.0);
  bool hot = false;
  if (u_thermal) {
    ivec2 b = ivec2(floor((u_cellOriginMm + (vec2(p) + 0.5) * u_pitchMm - u_bulkOriginMm) * u_bulkInvPitch));
    if (all(greaterThanEqual(b, ivec2(0))) && all(lessThan(b, u_bulkSize))) hot = u_ambientK + texelFetch(u_bulk, b, 0).r >= u_fireK;
  }
  uint v = 0u;
  if (hot || f >= u_fireAt) v = 4u;
  else if (f > u_overAbove) v = 3u;
  else if (f >= u_underBelow) v = 2u;
  else if (f > u_untouchedFraction * u_underBelow) v = 1u;
  o_verdict = uvec4(v, 0u, 0u, 0u);
}`

/**
 * Sum reduction: each output texel sums a FACTOR×FACTOR block of the input
 * restricted to [u_min, u_max). Repeated until one texel remains.
 */
export const REDUCE_FACTOR = 8
export const REDUCE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform ivec2 u_min;
uniform ivec2 u_max;
out vec4 o;
void main() {
  ivec2 base = u_min + ivec2(gl_FragCoord.xy) * ${REDUCE_FACTOR};
  float acc = 0.0;
  for (int j = 0; j < ${REDUCE_FACTOR}; j++)
    for (int i = 0; i < ${REDUCE_FACTOR}; i++) {
      ivec2 q = base + ivec2(i, j);
      if (all(lessThan(q, u_max))) acc += texelFetch(u_src, q, 0).r;
    }
  o = vec4(acc, 0.0, 0.0, 0.0);
}`

/**
 * Overview composite for the UI canvas: each overview pixel box-averages the
 * colour of the job cells it covers, clamped to this tile's core, and takes
 * the worst verdict among them. Drawn once per tile with a scissor on the
 * pixels whose centre falls in the core.
 */
export const OVERVIEW_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_color;
uniform highp usampler2D u_verdict;
uniform highp sampler2D u_fluence;
uniform highp sampler2D u_depth;
uniform vec2 u_cellsPerPixel;
uniform vec2 u_coreMin;
uniform vec2 u_coreMax;
uniform vec2 u_paddedOrigin;
uniform int u_taps;
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_verdict;
layout(location = 2) out vec4 o_field;
layout(location = 3) out vec4 o_cover;
void main() {
  vec2 lo = max(floor(gl_FragCoord.xy - 0.5) * u_cellsPerPixel, u_coreMin);
  vec2 hi = min((floor(gl_FragCoord.xy - 0.5) + 1.0) * u_cellsPerPixel, u_coreMax);
  vec2 step = max((hi - lo) / float(u_taps), vec2(1e-6));
  vec4 acc = vec4(0.0);
  vec2 field = vec2(0.0);
  vec4 cover = vec4(0.0);
  uint worst = 0u;
  float n = 0.0;
  for (int j = 0; j < u_taps; j++)
    for (int i = 0; i < u_taps; i++) {
      vec2 c = lo + (vec2(i, j) + 0.5) * step;
      if (any(greaterThanEqual(c, hi))) continue;
      ivec2 q = ivec2(floor(c - u_paddedOrigin));
      acc += texelFetch(u_color, q, 0);
      field += vec2(texelFetch(u_fluence, q, 0).r, texelFetch(u_depth, q, 0).r);
      uint v = texelFetch(u_verdict, q, 0).r;
      cover += vec4(equal(uvec4(v), uvec4(1u, 2u, 3u, 4u)));
      worst = max(worst, v);
      n += 1.0;
    }
  o_color = n > 0.0 ? acc / n : vec4(0.0);
  o_verdict = uvec4(worst, 0u, 0u, 0u);
  o_field = vec4(n > 0.0 ? field / n : vec2(0.0), 0.0, 1.0);
  o_cover = n > 0.0 ? cover / n : vec4(0.0);
}`

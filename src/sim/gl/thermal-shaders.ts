// SPDX-License-Identifier: MIT
// GLSL ES 3.00 for the WebGL2 thermal step (COD-258). Each stage mirrors the
// CPU reference in thermal.ts (CpuThermalGrid, finishSample); keep them in step.
//
// Textures:
//   state      RGBA32F, thermal grid: excess temperature (K) of layers 0..3 in r, g, b, a
//   doseAcc    R32F, thermal grid: accumulated dose (J/mm²) for absorption feedback
//   perSample  RG32F, PER_SAMPLE_WIDTH wide, texel i = sample i: (eAbs, eDose) in J
//   pre        RG32F, same layout from the bin's first sample: the gather before injection
//   bulk       R32F, thermal grid: highest bulk temperature (K above ambient) gathered there
//   fresh      RGBA32F, thermal grid: the bin's injected heat, then spread (injectSpreadCells2),
//              valid inside the bin's fresh rect only; landed in the state by the next diffusion

/** Per-sample textures are this wide; sample i is texel (i % width, i / width). */
export const PER_SAMPLE_WIDTH = 4096

const MIRROR = `
int mirrorIndex(int i, int n) {
  int p = 2 * n;
  int m = i - p * int(floor(float(i) / float(p)));
  return m < n ? m : p - 1 - m;
}`

/**
 * One lateral pass (u_dir) over all four layers, mirror edges. With u_depth,
 * also the implicit depth step. u_maskSrc reads the source as zero outside
 * u_srcRect (the fresh-heat region); u_hasAdd adds u_add inside u_addRect to
 * the source (landing the spread fresh heat in the state). Rects are
 * (x0, y0, x1, y1), end-exclusive.
 */
export const THERMAL_DIFFUSE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_src;
uniform highp sampler2D u_taps;
uniform int u_radius;
uniform ivec2 u_dir;
uniform ivec2 u_size;
uniform bool u_depth;
uniform vec4 u_cap;
uniform vec4 u_m;
uniform vec4 u_b;
uniform vec4 u_c;
uniform bool u_maskSrc;
uniform ivec4 u_srcRect;
uniform bool u_hasAdd;
uniform highp sampler2D u_add;
uniform ivec4 u_addRect;
out vec4 o;
${MIRROR}
bool inRect(ivec2 q, ivec4 r) { return q.x >= r.x && q.y >= r.y && q.x < r.z && q.y < r.w; }
vec4 source(ivec2 q) {
  if (u_maskSrc && !inRect(q, u_srcRect)) return vec4(0.0);
  vec4 v = texelFetch(u_src, q, 0);
  if (u_hasAdd && inRect(q, u_addRect)) v += texelFetch(u_add, q, 0);
  return v;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int t = -u_radius; t <= u_radius; t++) {
    ivec2 q = p + u_dir * t;
    q = ivec2(mirrorIndex(q.x, u_size.x), mirrorIndex(q.y, u_size.y));
    acc += source(q) * texelFetch(u_taps, ivec2(t + u_radius, 0), 0).r;
  }
  if (u_depth) {
    // Thomas sweep with the elimination precomputed on the CPU (contract depthSolver).
    vec4 d = acc * u_cap;
    d.y -= u_m.y * d.x;
    d.z -= u_m.z * d.y;
    d.w -= u_m.w * d.z;
    d.w = d.w / u_b.w;
    d.z = (d.z - u_c.z * d.w) / u_b.z;
    d.y = (d.y - u_c.y * d.z) / u_b.y;
    d.x = (d.x - u_c.x * d.y) / u_b.x;
    acc = d;
  }
  o = acc;
}`

/** Thermal-grid placement shared by inject and gather: continuous cell coordinates with centres at integers. */
const GRID = `
uniform vec2 u_origin;
uniform float u_invPitch;
uniform ivec2 u_gridSize;
vec2 cellCoord(vec2 xy) { return (xy - u_origin) * u_invPitch - 0.5; }
ivec2 perSampleTexel(int i) { return ivec2(i % ${PER_SAMPLE_WIDTH}, i / ${PER_SAMPLE_WIDTH}); }
vec4 atTexel(ivec2 t, ivec2 size) { return vec4((vec2(t) + 0.5) / vec2(size) * 2.0 - 1.0, 0.0, 1.0); }`

/**
 * Inject: one instance per sample (u_first + gl_InstanceID), four 1-pixel
 * points, one per bilinear neighbour (clamped into the grid, as on the CPU).
 * Adds heat per layer to `state` and dose to `doseAcc` (MRT, additive).
 */
export const THERMAL_INJECT_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_xye;
uniform highp sampler2D u_perSample;
uniform int u_first;
uniform vec4 u_layerScale;
uniform float u_invArea;
${GRID}
out vec4 v_heat;
out float v_dose;
void main() {
  vec2 e = texelFetch(u_perSample, perSampleTexel(u_first + gl_InstanceID), 0).rg;
  vec2 f = cellCoord(a_xye.xy);
  vec2 i0 = floor(f);
  vec2 a = f - i0;
  vec2 d = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 w = mix(1.0 - a, a, d);
  float wt = w.x * w.y;
  v_heat = wt * e.x * u_layerScale;
  v_dose = wt * e.y * u_invArea;
  ivec2 cell = clamp(ivec2(i0 + d), ivec2(0), u_gridSize - 1);
  gl_Position = atTexel(cell, u_gridSize);
  gl_PointSize = 1.0;
}`

export const THERMAL_INJECT_FS = `#version 300 es
precision highp float;
in vec4 v_heat;
in float v_dose;
layout(location = 0) out vec4 o_heat;
layout(location = 1) out vec4 o_dose;
void main() {
  o_heat = v_heat;
  o_dose = vec4(v_dose, 0.0, 0.0, 0.0);
}`

/**
 * Gather: one point per sample (gl_VertexID is the store index). Reads the
 * top layer (state plus spread fresh heat) and the accumulated dose bilinearly.
 * u_final = false writes (bulk, dose) to the `pre` texture at index − u_binFirst.
 * u_final = true blends with `pre` by the sample's bin fraction and writes
 * (eAbs, eDose) to `perSample` at the store index (finishSample).
 */
export const THERMAL_GATHER_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_xye;
layout(location = 1) in vec3 a_static;
uniform highp sampler2D u_state;
uniform highp sampler2D u_doseAcc;
uniform highp sampler2D u_pre;
uniform bool u_hasFresh;
uniform highp sampler2D u_fresh;
uniform ivec4 u_freshRect;
uniform int u_binFirst;
uniform bool u_final;
uniform ivec2 u_outSize;
uniform float u_absorption;
uniform float u_absorptionFull;
uniform bool u_feedback;
uniform float u_rampStart;
uniform float u_rampEnd;
uniform float u_gamma;
${GRID}
${MIRROR}
out vec2 v_out;

/** Top layer of the state plus the spread fresh heat not yet landed in it. */
float top(ivec2 q) {
  float v = texelFetch(u_state, q, 0).r;
  if (u_hasFresh && q.x >= u_freshRect.x && q.y >= u_freshRect.y && q.x < u_freshRect.z && q.y < u_freshRect.w)
    v += texelFetch(u_fresh, q, 0).r;
  return v;
}

/** Bilinear read of the top layer, mirror edges. */
float gatherBulk(vec2 f) {
  ivec2 i0 = ivec2(floor(f));
  vec2 a = f - floor(f);
  ivec2 i1 = i0 + 1;
  i0 = ivec2(mirrorIndex(i0.x, u_gridSize.x), mirrorIndex(i0.y, u_gridSize.y));
  i1 = ivec2(mirrorIndex(i1.x, u_gridSize.x), mirrorIndex(i1.y, u_gridSize.y));
  float r0 = top(ivec2(i0.x, i0.y)) * (1.0 - a.x) + top(ivec2(i1.x, i0.y)) * a.x;
  float r1 = top(ivec2(i0.x, i1.y)) * (1.0 - a.x) + top(ivec2(i1.x, i1.y)) * a.x;
  return r0 * (1.0 - a.y) + r1 * a.y;
}

float doseAt(ivec2 c) { return texelFetch(u_doseAcc, clamp(c, ivec2(0), u_gridSize - 1), 0).r; }

float gatherDose(vec2 f) {
  ivec2 i0 = ivec2(floor(f));
  vec2 a = f - floor(f);
  float r0 = doseAt(i0) * (1.0 - a.x) + doseAt(i0 + ivec2(1, 0)) * a.x;
  float r1 = doseAt(i0 + ivec2(0, 1)) * (1.0 - a.x) + doseAt(i0 + ivec2(1, 1)) * a.x;
  return r0 * (1.0 - a.y) + r1 * a.y;
}

float rampT(float v) {
  float span = u_rampEnd - u_rampStart;
  float t = span > 0.0 ? (v - u_rampStart) / span : (v >= u_rampStart ? 1.0 : 0.0);
  t = clamp(t, 0.0, 1.0);
  return u_gamma == 1.0 ? t : pow(t, u_gamma);
}

void main() {
  vec2 f = cellCoord(a_xye.xy);
  float bulk = gatherBulk(f);
  float dose = gatherDose(f);
  int i = gl_VertexID;
  if (!u_final) {
    v_out = vec2(bulk, dose);
    gl_Position = atTexel(perSampleTexel(i - u_binFirst), u_outSize);
  } else {
    vec2 pre = texelFetch(u_pre, perSampleTexel(i - u_binFirst), 0).rg;
    float frac = a_static.z;
    bulk = pre.x + (bulk - pre.x) * frac;
    dose = pre.y + (dose - pre.y) * frac;
    float a = u_absorption + (u_absorptionFull - u_absorption) * (u_feedback ? rampT(dose) : 0.0);
    float eAbs = a_xye.z * a;
    v_out = vec2(eAbs, eAbs * (a_static.x + bulk * a_static.y / a));
    gl_Position = atTexel(perSampleTexel(i), u_outSize);
  }
  gl_PointSize = 1.0;
}`

export const THERMAL_GATHER_FS = `#version 300 es
precision highp float;
in vec2 v_out;
out vec4 o;
void main() { o = vec4(v_out, 0.0, 0.0); }`

/**
 * Bulk map: one point per sample at its thermal cell, MAX-blended. The bulk
 * temperature it gathered is recovered from its energies:
 * eDose / eAbs = flash + bulk · bulkGain / a, with a = eAbs / E.
 */
export const THERMAL_BULK_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_xye;
layout(location = 1) in vec3 a_static;
uniform highp sampler2D u_perSample;
${GRID}
out float v_bulk;
void main() {
  vec2 e = texelFetch(u_perSample, perSampleTexel(gl_VertexID), 0).rg;
  bool ok = e.x > 0.0 && a_static.y > 0.0;
  v_bulk = ok ? (e.y / e.x - a_static.x) * (e.x / a_xye.z) / a_static.y : 0.0;
  ivec2 c = clamp(ivec2(floor((a_xye.xy - u_origin) * u_invPitch)), ivec2(0), u_gridSize - 1);
  gl_Position = atTexel(c, u_gridSize);
  gl_PointSize = 1.0;
}`

export const THERMAL_BULK_FS = `#version 300 es
precision highp float;
in float v_bulk;
out vec4 o;
void main() { o = vec4(v_bulk, 0.0, 0.0, 0.0); }`

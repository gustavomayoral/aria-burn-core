// SPDX-License-Identifier: MIT
// GLSL for the burn view (COD-259). BURN_VIEW_FS mirrors burn-view.ts
// (shadeBurnView) line for line; keep the two in step.

const NOISE = `
float hash2(ivec2 q) {
  uint h = (uint(q.x) * 0x8da6b343u) ^ (uint(q.y) * 0xd8163841u);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h ^= h >> 15u;
  return float(h) / 4294967296.0;
}
float valueNoise(vec2 v) {
  vec2 i = floor(v);
  vec2 f = v - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 q = ivec2(i);
  float a = hash2(q);
  float b = hash2(q + ivec2(1, 0));
  float c = hash2(q + ivec2(0, 1));
  float d = hash2(q + ivec2(1, 1));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
float baseGain(int kind, vec2 mm) {
  if (kind == 0) {
    float warp = valueNoise(mm / vec2(14.0, 3.5));
    float fibre = valueNoise(mm / vec2(1.6, 0.22));
    float phase = mm.y / 1.9 + 1.6 * warp;
    float band = pow(0.5 + 0.5 * sin(6.2831853 * phase), 3.0);
    return 1.04 - 0.12 * band - 0.05 * (fibre - 0.5);
  }
  if (kind == 1) return 1.0 + 0.035 * (valueNoise(mm / 40.0) - 0.5);
  return 1.0 + 0.07 * (valueNoise(mm / vec2(30.0, 0.05)) - 0.5) + 0.025 * (valueNoise(mm / 6.0) - 0.5);
}
`

export const BURN_VIEW_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform vec2 u_canvas;
uniform vec2 u_center;
uniform float u_mmPerPx;

uniform sampler2D u_color0;
uniform sampler2D u_field0;
uniform sampler2D u_cover0;
uniform vec2 u_origin0;
uniform float u_texel0;
uniform vec2 u_size0;
uniform vec2 u_cap0;
uniform bool u_has0;

uniform sampler2D u_color1;
uniform sampler2D u_field1;
uniform sampler2D u_cover1;
uniform vec2 u_origin1;
uniform float u_texel1;
uniform vec2 u_size1;
uniform vec2 u_cap1;
uniform bool u_has1;

uniform int u_texture;
uniform vec3 u_base;
uniform vec3 u_halo;
uniform float u_rampStart;
uniform float u_rampEnd;
uniform float u_gamma;
uniform bool u_haloOn;
uniform bool u_relief;
uniform bool u_overlay;
uniform float u_regionMm;
uniform float u_haloMm;
uniform float u_haloAlpha;
uniform float u_overlayAlpha;
uniform vec3 u_verdictRgb[5];
uniform vec3 u_fireDark;

layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_depth;
${NOISE}
float rampT(float q) {
  float span = u_rampEnd - u_rampStart;
  float t = span > 0.0 ? (q - u_rampStart) / span : (q >= u_rampStart ? 1.0 : 0.0);
  t = clamp(t, 0.0, 1.0);
  return u_gamma != 1.0 ? pow(t, u_gamma) : t;
}
float reliefShade(vec2 g) {
  vec3 l = vec3(-0.48, 0.6, 0.64);
  float lambert = dot(vec3(g, 1.0), l) / length(vec3(g, 1.0));
  return clamp(lambert / l.z, 0.45, 1.35);
}
uniform float u_regionMinCover;
uint regionOf(vec4 c) {
  if (c.a > 1e-4) return 4u;
  if (c.r + c.g + c.b < u_regionMinCover) return 0u;
  if (c.b >= c.g && c.b >= c.r) return 3u;
  return c.g >= c.r ? 2u : 1u;
}

// Shades the layer at mm; false when mm is outside it.
bool shade(sampler2D color, sampler2D field, sampler2D cover, vec2 origin, float texel, vec2 size, vec2 cap, vec2 mm, out vec3 rgb, out float depth) {
  vec2 p = (mm - origin) / texel;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, size))) return false;
  // Never sample finer than a screen pixel: minified views read the mip chain.
  float pxTexels = max(u_mmPerPx / texel, 1.0);
  float lod = log2(pxTexels);
  vec2 uv = p / cap;
  rgb = textureLod(color, uv, lod).rgb;
  vec4 f = textureLod(field, uv, lod);
  depth = f.g;
  float t = rampT(f.r);
  rgb += u_base * (baseGain(u_texture, mm) - 1.0) * (1.0 - t);
  if (u_haloOn) {
    float qb = textureLod(field, uv, max(lod, round(log2(max(1.0, u_haloMm / texel))))).r;
    float over = clamp((qb - 0.35 * u_rampEnd) / u_rampEnd, 0.0, 1.0);
    rgb = mix(rgb, u_halo, u_haloAlpha * over * (1.0 - t));
  }
  if (u_relief) {
    vec2 d = vec2(pxTexels / cap.x, 0.0);
    vec2 e = vec2(0.0, pxTexels / cap.y);
    float h = 2.0 * pxTexels * texel;
    vec2 g = vec2(textureLod(field, uv + d, lod).g - textureLod(field, uv - d, lod).g,
                  textureLod(field, uv + e, lod).g - textureLod(field, uv - e, lod).g) / h;
    rgb *= reliefShade(g);
  }
  if (u_overlay) {
    float rl = max(lod, round(log2(max(1.0, u_regionMm / texel))));
    uint v = regionOf(textureLod(cover, uv, rl));
    if (v != 0u) {
      vec2 px = vec2(pxTexels) / cap;
      bool edge = regionOf(textureLod(cover, uv + vec2(px.x, 0.0), rl)) != v || regionOf(textureLod(cover, uv + vec2(0.0, px.y), rl)) != v;
      ivec2 s = ivec2(gl_FragCoord.xy);
      bool dark = v == 4u && ((s.x + s.y) & 3) >= 2;
      vec3 fill = dark ? u_fireDark : u_verdictRgb[v];
      rgb = mix(rgb, fill, edge ? 0.9 : u_overlayAlpha);
    }
  }
  return true;
}

void main() {
  vec2 mm = u_center + (gl_FragCoord.xy - 0.5 * u_canvas) * u_mmPerPx;
  vec3 rgb;
  float depth = 0.0;
  bool hit = u_has1 && shade(u_color1, u_field1, u_cover1, u_origin1, u_texel1, u_size1, u_cap1, mm, rgb, depth);
  if (!hit) hit = u_has0 && shade(u_color0, u_field0, u_cover0, u_origin0, u_texel0, u_size0, u_cap0, mm, rgb, depth);
  // Outside the job grid: the unburned sheet.
  if (!hit) rgb = u_base * baseGain(u_texture, mm);
  o_color = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  o_depth = vec4(depth, 0.0, 0.0, 1.0);
}`

/** Packs a tile's core (R32F fluence/dose, R32F depth, colour, verdict) into the burn view's detail layer. */
export const DETAIL_PACK_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D u_color;
uniform sampler2D u_fluence;
uniform sampler2D u_depth;
uniform usampler2D u_verdict;
uniform ivec2 u_offset;
layout(location = 0) out vec4 o_color;
layout(location = 1) out uvec4 o_verdict;
layout(location = 2) out vec4 o_field;
layout(location = 3) out vec4 o_cover;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) + u_offset;
  o_color = texelFetch(u_color, q, 0);
  uint v = texelFetch(u_verdict, q, 0).r;
  o_verdict = uvec4(v, 0u, 0u, 0u);
  o_cover = vec4(equal(uvec4(v), uvec4(1u, 2u, 3u, 4u)));
  o_field = vec4(texelFetch(u_fluence, q, 0).r, texelFetch(u_depth, q, 0).r, 0.0, 1.0);
}`

/** Worst verdict per block of layer texels (the fire-risk and legend summary). */
export const VERDICT_SUMMARY_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_verdict;
uniform vec2 u_size;
uniform float u_block;
layout(location = 0) out uvec4 o_verdict;
void main() {
  vec2 lo = floor(gl_FragCoord.xy - 0.5) * u_block;
  vec2 hi = min(lo + u_block, u_size);
  uint worst = 0u;
  for (float y = lo.y; y < hi.y; y += 1.0)
    for (float x = lo.x; x < hi.x; x += 1.0) worst = max(worst, texelFetch(u_verdict, ivec2(x, y), 0).r);
  o_verdict = uvec4(worst, 0u, 0u, 0u);
}`

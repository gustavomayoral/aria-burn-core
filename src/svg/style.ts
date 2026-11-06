// SPDX-License-Identifier: MIT
// SVG paint and the few style properties the import needs (BURN-50): stroke,
// fill, fill-rule, display, visibility, color, clip-path and mask, from
// presentation attributes, `<style>` sheets (simple selectors only) and inline
// `style`, with inheritance from parent groups.

import type { XmlElement } from './xml.ts'

/** Properties read from an element. Values are raw strings; paint is resolved later. */
export const STYLE_PROPERTIES = ['stroke', 'fill', 'fill-rule', 'display', 'visibility', 'color', 'clip-path', 'mask'] as const
export type StyleProperty = (typeof STYLE_PROPERTIES)[number]
export type Declarations = Partial<Record<StyleProperty, string>>

export interface ComputedStyle {
  stroke: string
  fill: string
  fillRule: string
  visibility: string
  color: string
  display: string
  clipPath: string | null
  mask: string | null
}

/** The initial values (SVG 1.1): fill black, stroke none. */
export const INITIAL_STYLE: ComputedStyle = {
  stroke: 'none',
  fill: 'black',
  fillRule: 'nonzero',
  visibility: 'visible',
  color: 'black',
  display: 'inline',
  clipPath: null,
  mask: null,
}

/** Parses `a: b; c: d` into declarations for the properties we read. `!important` is dropped. */
export function parseDeclarations(text: string): Declarations {
  const out: Declarations = {}
  for (const part of text.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const name = part.slice(0, i).trim().toLowerCase() as StyleProperty
    if (!(STYLE_PROPERTIES as readonly string[]).includes(name)) continue
    const value = part
      .slice(i + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
    if (value) out[name] = value
  }
  return out
}

// --- Style sheets ---

interface SimpleSelector {
  tag: string | null
  id: string | null
  classes: string[]
  specificity: number
}

export interface CssRule {
  selector: SimpleSelector
  declarations: Declarations
  order: number
}

export interface StyleSheet {
  rules: CssRule[]
  /** Selectors and at-rules we could not apply, verbatim. */
  unsupported: string[]
}

const SIMPLE = /^(\*|[A-Za-z][\w-]*)?((?:[.#][\w-]+)*)$/

export function parseStyleSheet(css: string, sheet: StyleSheet = { rules: [], unsupported: [] }): StyleSheet {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf('{', pos)
    if (open < 0) break
    const prelude = text.slice(pos, open).trim()
    // Matching close brace (at-rules like @media nest one level).
    let depth = 1
    let i = open + 1
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') depth--
    }
    const body = text.slice(open + 1, i - 1)
    pos = i
    if (prelude.startsWith('@')) {
      sheet.unsupported.push(prelude.split(/\s/)[0]!)
      continue
    }
    const declarations = parseDeclarations(body)
    for (const raw of prelude.split(',')) {
      const sel = raw.trim()
      if (!sel) continue
      const m = SIMPLE.exec(sel)
      if (!m || (!m[1] && !m[2])) {
        sheet.unsupported.push(sel)
        continue
      }
      const parts = m[2]!.match(/[.#][\w-]+/g) ?? []
      const ids = parts.filter((p) => p[0] === '#').map((p) => p.slice(1))
      if (ids.length > 1) {
        sheet.unsupported.push(sel)
        continue
      }
      const classes = parts.filter((p) => p[0] === '.').map((p) => p.slice(1))
      const tag = m[1] && m[1] !== '*' ? m[1] : null
      sheet.rules.push({
        selector: { tag, id: ids[0] ?? null, classes, specificity: (ids.length ? 100 : 0) + classes.length * 10 + (tag ? 1 : 0) },
        declarations,
        order: sheet.rules.length,
      })
    }
  }
  return sheet
}

function matches(sel: SimpleSelector, tag: string, el: XmlElement): boolean {
  if (sel.tag && sel.tag !== tag) return false
  if (sel.id && el.attributes.id !== sel.id) return false
  if (sel.classes.length) {
    const have = (el.attributes.class ?? '').split(/\s+/)
    if (!sel.classes.every((c) => have.includes(c))) return false
  }
  return true
}

/**
 * The element's own declarations in cascade order: presentation attributes,
 * then matching sheet rules by specificity and source order, then inline style.
 */
export function elementDeclarations(el: XmlElement, tag: string, sheet: StyleSheet): Declarations {
  const out: Declarations = {}
  for (const p of STYLE_PROPERTIES) {
    const v = el.attributes[p]
    if (v !== undefined && v.trim() !== '') out[p] = v.trim()
  }
  const rules = sheet.rules
    .filter((r) => matches(r.selector, tag, el))
    .sort((a, b) => a.selector.specificity - b.selector.specificity || a.order - b.order)
  for (const r of rules) Object.assign(out, r.declarations)
  if (el.attributes.style) Object.assign(out, parseDeclarations(el.attributes.style))
  return out
}

/** Computes an element's style from its parent's and its own declarations. */
export function computeStyle(parent: ComputedStyle, decl: Declarations): ComputedStyle {
  // Only inherited properties go through here; `inherit` is explicit inheritance.
  const pick = (p: StyleProperty, inherited: string): string => {
    const v = decl[p]
    return v === undefined || v === 'inherit' ? inherited : v
  }
  const nonInherited = (v: string | undefined): string | null => (v === undefined || v === 'none' ? null : v)
  return {
    stroke: pick('stroke', parent.stroke),
    fill: pick('fill', parent.fill),
    fillRule: pick('fill-rule', parent.fillRule),
    visibility: pick('visibility', parent.visibility),
    color: pick('color', parent.color),
    display: decl.display ?? 'inline',
    clipPath: nonInherited(decl['clip-path']),
    mask: nonInherited(decl.mask),
  }
}

// --- Colours ---

export type Paint = { kind: 'none' } | { kind: 'color'; hex: string } | { kind: 'unsupported'; value: string }

/** Resolves a paint value to `#rrggbb`, none, or unsupported (gradients, patterns, unknown keywords). */
export function resolvePaint(value: string, currentColor: string): Paint {
  const v = value.trim()
  const lower = v.toLowerCase()
  if (lower === 'none' || lower === 'transparent') return { kind: 'none' }
  if (lower === 'currentcolor') {
    const c = parseColor(currentColor)
    return c ? { kind: 'color', hex: c } : { kind: 'unsupported', value: currentColor }
  }
  if (lower.startsWith('url(')) {
    // A paint server with a fallback colour: `url(#g) red`.
    const fallback = v.slice(v.indexOf(')') + 1).trim()
    const c = fallback ? parseColor(fallback) : null
    return c ? { kind: 'color', hex: c } : { kind: 'unsupported', value: v }
  }
  const c = parseColor(v)
  return c ? { kind: 'color', hex: c } : { kind: 'unsupported', value: v }
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')

/** Parses a CSS colour (hex, rgb()/rgba(), named) to lowercase `#rrggbb`, or null. Alpha is ignored. */
export function parseColor(value: string): string | null {
  const v = value.trim().toLowerCase()
  let m = /^#([0-9a-f]{3,8})$/.exec(v)
  if (m) {
    const h = m[1]!
    if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`
    return null
  }
  m = /^rgba?\(\s*([^)]*)\)$/.exec(v)
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3)
    if (parts.length !== 3) return null
    const channels = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)))
    if (channels.some((c) => !Number.isFinite(c))) return null
    return `#${channels.map(hex2).join('')}`
  }
  const named = NAMED_COLORS[v]
  return named ? `#${named}` : null
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// CSS Color Module Level 4 named colours.
const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  (
    'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 ' +
    'black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 ' +
    'chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff ' +
    'darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 ' +
    'darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
    'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f ' +
    'darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 ' +
    'dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
    'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 ' +
    'honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
    'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff ' +
    'lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 ' +
    'lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
    'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 ' +
    'mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
    'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 ' +
    'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 ' +
    'oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
    'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f ' +
    'pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f ' +
    'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
    'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
    'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 ' +
    'violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32'
  )
    .split(' ')
    .reduce<[string, string][]>((acc, tok, i, all) => (i % 2 === 0 ? [...acc, [tok, all[i + 1]!]] : acc), []),
)

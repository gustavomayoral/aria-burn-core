// SPDX-License-Identifier: MIT
// 2D affine transforms and the SVG `transform` attribute (BURN-50).

/** [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG's matrix order). */
export type Matrix = readonly [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** m·n: apply n first, then m. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

export const translate = (tx: number, ty: number): Matrix => [1, 0, 0, 1, tx, ty]
export const scale = (sx: number, sy: number = sx): Matrix => [sx, 0, 0, sy, 0, 0]
export function rotate(deg: number, cx = 0, cy = 0): Matrix {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0]
  return cx === 0 && cy === 0 ? rot : multiply(translate(cx, cy), multiply(rot, translate(-cx, -cy)))
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Applies only the linear part (for direction vectors). */
export function applyLinear(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

/**
 * Parses an SVG transform list. Returns null when the attribute is malformed;
 * per SVG an invalid transform list disables the element's transform, so the
 * caller decides what to do (it reports and falls back to identity).
 */
export function parseTransform(text: string): Matrix | null {
  let m = IDENTITY
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy
  let consumed = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    consumed = re.lastIndex
    const args = (match[2]!.match(NUMBER) ?? []).map(Number)
    const n = args.length
    let t: Matrix
    switch (match[1]) {
      case 'matrix':
        if (n !== 6) return null
        t = args as unknown as Matrix
        break
      case 'translate':
        if (n !== 1 && n !== 2) return null
        t = translate(args[0]!, args[1] ?? 0)
        break
      case 'scale':
        if (n !== 1 && n !== 2) return null
        t = scale(args[0]!, args[1] ?? args[0]!)
        break
      case 'rotate':
        if (n !== 1 && n !== 3) return null
        t = rotate(args[0]!, args[1] ?? 0, args[2] ?? 0)
        break
      case 'skewX':
        if (n !== 1) return null
        t = [1, 0, Math.tan((args[0]! * Math.PI) / 180), 1, 0, 0]
        break
      default: // skewY
        if (n !== 1) return null
        t = [1, Math.tan((args[0]! * Math.PI) / 180), 0, 1, 0, 0]
    }
    m = multiply(m, t)
  }
  if (text.slice(consumed).trim() !== '') return null
  return m
}

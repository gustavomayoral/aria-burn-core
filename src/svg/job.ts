// SPDX-License-Identifier: MIT
// SVG import moves (BURN-51, feature BURN-49): an imported SVG, its layer
// settings and a placement → GRBL G-code and, in lockstep, the JobModel the
// parser makes of it, through the calibration Toolpath. The app opens the
// G-code like any file (Rust parser → GRBL planner → simulator), so timing,
// M4 scaling and the burn views need nothing new. The G-code is internal: it
// drives the simulator and is never offered as an export.
//
// Line mode follows each subpath of the shapes `lineShapes` gives: those
// stroked in the layer's colour, and unstroked (fill-only) shapes, whose
// outline is traced. A shape on the layer only through its fill while stroked
// in another colour is not traced (BURN-53): SVG's default fill is black, so a
// stroked path without fill="none" would otherwise also be traced on C00.
// This matches LightBurn, which gives a shape its stroke colour's layer.
// Within a layer, paths go greedy
// nearest-start from where the head is: a closed path may start at any
// vertex, an open path may be reversed, and a closed path waits until every
// closed path inside it is done (inner shapes first, as LightBurn cuts them).
// Layers go in list order with G0 travel between paths, and each pass repeats
// the layer's moves in the same order.
//
// Power: M4 with S at max power % of $30 and F from the layer's speed. Min
// power is not simulated (BURN-49). A layer with output off, or hidden, writes
// no moves. Fill mode is BURN-52: a fill layer is reported and skipped here.
//
// Comments: "; Layer <id>" before each layer and "; Line @ F mm/min, P% power"
// before each pass, so the parser (passes.rs) labels the passes by layer.

import type { BoundsMm, JobModel, LayerSettings, MachineProfile } from '../contract/index.ts'
import { usableBedMm } from '../calibration/context.ts'
import { Toolpath } from '../calibration/toolpath.ts'
import { apply, type Matrix } from './matrix.ts'
import { placementMatrix, transformedBounds, type Placement } from './placement.ts'
import type { SvgDocument } from './read.ts'

/**
 * The shapes a layer traces in line mode (indices into doc.shapes): those
 * stroked in the layer's colour, and those with no stroke at all (their
 * outline). A shape stroked in another colour and on this layer only through
 * its fill (often SVG's default black fill) is left to its stroke's layer.
 */
export function lineShapes(doc: SvgDocument, layerIndex: number): number[] {
  const layer = doc.layers[layerIndex]
  if (!layer) return []
  return layer.shapes.filter((si) => {
    const s = doc.shapes[si]!
    return s.stroke === null || s.stroke === layer.color
  })
}

/** One layer to burn: a layer of the document by id, and its settings. The list order is the burn order. */
export interface SvgJobLayer {
  id: string
  settings: LayerSettings
}

/** The document's layers in its own order with the settings readSvg gave them. */
export const svgJobLayers = (doc: SvgDocument): SvgJobLayer[] => doc.layers.map((l) => ({ id: l.id, settings: l.settings }))

export interface SvgJobOptions {
  /** A smaller usable bed (mm), e.g. the material sheet. Clamped to the machine. */
  bedMm?: { x: number; y: number }
  /** JobModel source name. Default "svg-import.gcode". */
  name?: string
}

export type SvgJobDiagnosticCode = 'off-bed' | 'fill-not-available' | 'unknown-layer' | 'duplicate-layer' | 'speed-above-max-rate' | 'nothing-to-burn'

export interface SvgJobDiagnostic {
  severity: 'warning' | 'error'
  code: SvgJobDiagnosticCode
  message: string
  /** The layer id it concerns, if any. */
  layer?: string
}

/**
 * Where each G-code line came from, indexed by line - 1. -1 means none: the
 * header, a layer comment (layer set, path -1) or the program end.
 */
export interface SvgSourceMap {
  /** Index into SvgDocument.layers. */
  layer: Int32Array
  /** Index into SvgDocument.shapes. */
  shape: Int32Array
  /** Subpath index within the shape. */
  subpath: Int32Array
  /** 0-based pass of the layer. */
  pass: Int32Array
}

export interface SvgLineSource {
  layer: number
  shape: number
  subpath: number
  pass: number
}

/** The source of a 1-based G-code line, or null for one that comes from no layer. */
export function sourceAt(map: SvgSourceMap, line: number): SvgLineSource | null {
  const i = line - 1
  if (i < 0 || i >= map.layer.length || map.layer[i]! < 0) return null
  return { layer: map.layer[i]!, shape: map.shape[i]!, subpath: map.subpath[i]!, pass: map.pass[i]! }
}

export interface SvgJob {
  gcode: string
  job: JobModel
  sourceMap: SvgSourceMap
  diagnostics: SvgJobDiagnostic[]
  /** SVG mm → bed mm. */
  matrix: Matrix
  bedMm: { x: number; y: number }
  /** Bed bounds of the visible layers' geometry (what the user sees placed), or null. */
  designBounds: BoundsMm | null
  estimatedTimeS: number
}

interface Item {
  /** Bed mm, interleaved x, y. */
  pts: Float64Array
  closed: boolean
  shape: number
  subpath: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface Step {
  item: number
  /** First vertex visited. */
  start: number
  /** Open paths only: walk from the last vertex to the first. */
  reversed: boolean
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000)

/** Even-odd point-in-polygon. */
function inside(pts: Float64Array, x: number, y: number): boolean {
  let c = false
  const n = pts.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i]!
    const yi = pts[2 * i + 1]!
    const xj = pts[2 * j]!
    const yj = pts[2 * j + 1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/**
 * For each closed item, the closed items that contain it. One contains
 * another when its box holds the other's box and is larger, and the other's
 * first vertex is inside it. A uniform grid of boxes keeps this near-linear.
 */
function containers(items: readonly Item[]): number[][] {
  const out: number[][] = items.map(() => [])
  const closed = items.map((it, i) => (it.closed ? i : -1)).filter((i) => i >= 0)
  if (closed.length < 2) return out
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const i of closed) {
    const it = items[i]!
    minX = Math.min(minX, it.minX)
    minY = Math.min(minY, it.minY)
    maxX = Math.max(maxX, it.maxX)
    maxY = Math.max(maxY, it.maxY)
  }
  const g = Math.min(256, Math.ceil(Math.sqrt(closed.length)))
  const cw = Math.max((maxX - minX) / g, 1e-9)
  const ch = Math.max((maxY - minY) / g, 1e-9)
  const cx = (x: number) => Math.min(g - 1, Math.max(0, Math.floor((x - minX) / cw)))
  const cy = (y: number) => Math.min(g - 1, Math.max(0, Math.floor((y - minY) / ch)))
  const cells: number[][] = Array.from({ length: g * g }, () => [])
  for (const i of closed) {
    const it = items[i]!
    for (let y = cy(it.minY); y <= cy(it.maxY); y++) for (let x = cx(it.minX); x <= cx(it.maxX); x++) cells[y * g + x]!.push(i)
  }
  const eps = 1e-9
  for (const i of closed) {
    const a = items[i]!
    const px = a.pts[0]!
    const py = a.pts[1]!
    const areaA = (a.maxX - a.minX) * (a.maxY - a.minY)
    for (const j of cells[cy(py) * g + cx(px)]!) {
      if (j === i) continue
      const b = items[j]!
      if (b.minX > a.minX + eps || b.minY > a.minY + eps || b.maxX < a.maxX - eps || b.maxY < a.maxY - eps) continue
      if ((b.maxX - b.minX) * (b.maxY - b.minY) <= areaA) continue
      if (inside(b.pts, px, py)) out[i]!.push(j)
    }
  }
  return out
}

/**
 * Greedy nearest-start order from (x0, y0). Candidate starts (open ends,
 * every vertex of a closed path) sit in a uniform grid searched ring by ring.
 */
function order(items: readonly Item[], x0: number, y0: number): Step[] {
  const n = items.length
  if (!n) return []
  const outer = containers(items)
  const pending = new Int32Array(n)
  for (const cs of outer) for (const j of cs) pending[j]!++
  const done = new Uint8Array(n)

  let count = 0
  for (const it of items) count += it.closed ? it.pts.length / 2 : 2
  const ptItem = new Int32Array(count)
  const ptVert = new Int32Array(count)
  let minX = x0
  let minY = y0
  let maxX = x0
  let maxY = y0
  let k = 0
  items.forEach((it, i) => {
    const nv = it.pts.length / 2
    const verts = it.closed ? Array.from({ length: nv }, (_, v) => v) : [0, nv - 1]
    for (const v of verts) {
      ptItem[k] = i
      ptVert[k] = v
      k++
    }
    minX = Math.min(minX, it.minX)
    minY = Math.min(minY, it.minY)
    maxX = Math.max(maxX, it.maxX)
    maxY = Math.max(maxY, it.maxY)
  })
  const g = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(count / 4))))
  const cs = Math.max((maxX - minX) / g, (maxY - minY) / g, 1e-6)
  const gx = Math.max(1, Math.ceil((maxX - minX) / cs + 1e-9))
  const gy = Math.max(1, Math.ceil((maxY - minY) / cs + 1e-9))
  const cell = (x: number, y: number) => [Math.min(gx - 1, Math.floor((x - minX) / cs)), Math.min(gy - 1, Math.floor((y - minY) / cs))] as const
  const cells: number[][] = Array.from({ length: gx * gy }, () => [])
  for (let p = 0; p < count; p++) {
    const it = items[ptItem[p]!]!
    const [x, y] = cell(it.pts[2 * ptVert[p]!]!, it.pts[2 * ptVert[p]! + 1]!)
    cells[y * gx + x]!.push(p)
  }

  const steps: Step[] = []
  let hx = x0
  let hy = y0
  for (let left = n; left > 0; left--) {
    const [qx, qy] = cell(hx, hy)
    let best = -1
    let bestD = Infinity
    const maxR = Math.max(gx, gy)
    for (let r = 0; r <= maxR; r++) {
      // Every cell in ring r is at least (r - 1) cells away.
      if (best >= 0 && (r - 1) * cs > Math.sqrt(bestD)) break
      for (let y = qy - r; y <= qy + r; y++) {
        if (y < 0 || y >= gy) continue
        const edge = y === qy - r || y === qy + r
        for (let x = qx - r; x <= qx + r; x += edge ? 1 : 2 * r || 1) {
          if (x < 0 || x >= gx) continue
          const list = cells[y * gx + x]!
          for (let q = 0; q < list.length; q++) {
            const p = list[q]!
            const i = ptItem[p]!
            if (done[i]) {
              list[q] = list[list.length - 1]!
              list.pop()
              q--
              continue
            }
            if (pending[i]! > 0) continue
            const it = items[i]!
            const v = ptVert[p]!
            const d = (it.pts[2 * v]! - hx) ** 2 + (it.pts[2 * v + 1]! - hy) ** 2
            if (d < bestD || (d === bestD && p < best)) {
              bestD = d
              best = p
            }
          }
        }
      }
    }
    if (best < 0) throw new Error('svg job: no path is available to burn next (containment cycle)')
    const i = ptItem[best]!
    const it = items[i]!
    const v = ptVert[best]!
    const nv = it.pts.length / 2
    const reversed = !it.closed && v !== 0
    steps.push({ item: i, start: it.closed ? v : 0, reversed })
    done[i] = 1
    for (const j of outer[i]!) pending[j]!--
    // The head ends where the path ends: back at the start of a closed path.
    const end = it.closed ? v : reversed ? 0 : nv - 1
    hx = it.pts[2 * end]!
    hy = it.pts[2 * end + 1]!
  }
  return steps
}

/**
 * G-code and its JobModel for an imported SVG. `layers` lists the layers to
 * consider in burn order (see svgJobLayers); document layers not listed are
 * not burned. A design partly off the bed is reported, not clipped.
 */
export function svgJob(
  doc: SvgDocument,
  layers: readonly SvgJobLayer[],
  placement: Placement,
  machine: MachineProfile,
  options: SvgJobOptions = {},
): SvgJob {
  const bedMm = usableBedMm(machine, options.bedMm)
  const m = placementMatrix(doc, placement)
  const diagnostics: SvgJobDiagnostic[] = []
  const byId = new Map(doc.layers.map((l, i) => [l.id, i]))
  const tp = new Toolpath<SvgLineSource>({ machine, bedMm }, { checkBed: false })
  const maxRate = Math.min(machine.maxRateMmPerMin.x, machine.maxRateMmPerMin.y)

  const seen = new Set<string>()
  const visibleShapes = new Set<number>()
  const plan: { index: number; settings: LayerSettings }[] = []
  for (const { id, settings } of layers) {
    const index = byId.get(id)
    if (index === undefined) {
      diagnostics.push({ severity: 'warning', code: 'unknown-layer', message: `Layer ${id} is not in the SVG`, layer: id })
      continue
    }
    if (seen.has(id)) {
      diagnostics.push({ severity: 'warning', code: 'duplicate-layer', message: `Layer ${id} is listed twice; the second is ignored`, layer: id })
      continue
    }
    seen.add(id)
    if (!settings.visible) continue
    for (const s of doc.layers[index]!.shapes) visibleShapes.add(s)
    if (!settings.output) continue
    if (settings.mode !== 'line') {
      diagnostics.push({ severity: 'warning', code: 'fill-not-available', message: `Layer ${id} is set to fill, which is not simulated yet; it is skipped`, layer: id })
      continue
    }
    if (settings.speedMmPerMin > maxRate)
      diagnostics.push({
        severity: 'warning',
        code: 'speed-above-max-rate',
        message: `Layer ${id} speed ${settings.speedMmPerMin} mm/min is above the machine's ${maxRate} mm/min; GRBL limits it`,
        layer: id,
      })
    plan.push({ index, settings })
  }

  tp.comment('Aria Burn SVG import: internal G-code for the simulator, not for a machine')
  tp.start()
  let hx = 0
  let hy = 0
  for (const { index, settings } of plan) {
    const layer = doc.layers[index]!
    const items: Item[] = []
    for (const si of lineShapes(doc, index)) {
      const shape = doc.shapes[si]!
      shape.subpaths.forEach((sp, j) => {
        const src = sp.points
        if (src.length < 4) return
        const pts = new Float64Array(src.length)
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let p = 0; p < src.length; p += 2) {
          const [x, y] = apply(m, src[p]!, src[p + 1]!)
          pts[p] = x
          pts[p + 1] = y
          minX = Math.min(minX, x)
          minY = Math.min(minY, y)
          maxX = Math.max(maxX, x)
          maxY = Math.max(maxY, y)
        }
        if (maxX - minX < 1e-6 && maxY - minY < 1e-6) return
        items.push({ pts, closed: sp.closed, shape: si, subpath: j, minX, minY, maxX, maxY })
      })
    }
    if (!items.length) continue
    const steps = order(items, hx, hy)
    const s = (settings.maxPowerPct / 100) * machine.sMax
    const f = settings.speedMmPerMin
    tp.setTag({ layer: index, shape: -1, subpath: -1, pass: -1 })
    tp.comment(`Layer ${layer.id}`)
    for (let pass = 0; pass < settings.passes; pass++) {
      tp.setTag({ layer: index, shape: -1, subpath: -1, pass })
      tp.comment(`Line @ ${fmt(f)} mm/min, ${fmt(settings.maxPowerPct)}% power${settings.passes > 1 ? `, pass ${pass + 1} of ${settings.passes}` : ''}`)
      for (const step of steps) {
        const it = items[step.item]!
        tp.setTag({ layer: index, shape: it.shape, subpath: it.subpath, pass })
        const nv = it.pts.length / 2
        const at = (k: number): [number, number] => [it.pts[2 * k]!, it.pts[2 * k + 1]!]
        if (it.closed) {
          tp.rapid(...at(step.start))
          for (let k = 1; k <= nv; k++) tp.cut(...at((step.start + k) % nv), f, s)
        } else if (step.reversed) {
          tp.rapid(...at(nv - 1))
          for (let k = nv - 2; k >= 0; k--) tp.cut(...at(k), f, s)
        } else {
          tp.rapid(...at(0))
          for (let k = 1; k < nv; k++) tp.cut(...at(k), f, s)
        }
      }
    }
    const last = items[steps[steps.length - 1]!.item]!
    const lastStep = steps[steps.length - 1]!
    const endV = last.closed ? lastStep.start : lastStep.reversed ? 0 : last.pts.length / 2 - 1
    hx = last.pts[2 * endV]!
    hy = last.pts[2 * endV + 1]!
  }
  tp.setTag(null)
  tp.end()

  const job = tp.job(options.name ?? 'svg-import.gcode')
  if (!job.burnBounds) diagnostics.push({ severity: 'warning', code: 'nothing-to-burn', message: 'No layer burns anything' })

  const designBounds = transformedBounds(doc, m, visibleShapes)
  if (designBounds) {
    const over = [
      -designBounds.minXMm,
      -designBounds.minYMm,
      designBounds.maxXMm - bedMm.x,
      designBounds.maxYMm - bedMm.y,
    ]
    if (over.some((d) => d > 1e-6))
      diagnostics.push({
        severity: 'warning',
        code: 'off-bed',
        message: `The design (${fmt(designBounds.minXMm)}, ${fmt(designBounds.minYMm)}) to (${fmt(designBounds.maxXMm)}, ${fmt(designBounds.maxYMm)}) mm leaves the ${fmt(bedMm.x)} × ${fmt(bedMm.y)} mm bed by up to ${fmt(Math.max(...over))} mm`,
      })
  }

  const tags = tp.lineTags()
  const sourceMap: SvgSourceMap = {
    layer: new Int32Array(tags.length).fill(-1),
    shape: new Int32Array(tags.length).fill(-1),
    subpath: new Int32Array(tags.length).fill(-1),
    pass: new Int32Array(tags.length).fill(-1),
  }
  tags.forEach((t, i) => {
    if (!t) return
    sourceMap.layer[i] = t.layer
    sourceMap.shape[i] = t.shape
    sourceMap.subpath[i] = t.subpath
    sourceMap.pass[i] = t.pass
  })

  return { gcode: tp.gcode(), job, sourceMap, diagnostics, matrix: m, bedMm, designBounds, estimatedTimeS: tp.estimatedTimeS }
}


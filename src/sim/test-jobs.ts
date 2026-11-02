// SPDX-License-Identifier: MIT
// Synthetic job models for tests and the benchmark page, shaped like parser
// output (contract JobModel): absolute mm, modal state resolved per move.

import { CONTRACT_VERSION, type BoundsMm, type JobModel, type LaserMode, type Move } from '../contract/index.ts'

export interface RasterOptions {
  x0Mm: number
  y0Mm: number
  widthMm: number
  heightMm: number
  /** Line interval (mm). */
  intervalMm: number
  feedMmPerMin: number
  s: number
  laser?: LaserMode
  /** Alternate direction every line (LightBurn's default). */
  bidirectional?: boolean
}

function job(name: string, moves: Move[], burn: BoundsMm | null): JobModel {
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  for (const m of moves) {
    minX = Math.min(minX, m.xMm)
    minY = Math.min(minY, m.yMm)
    maxX = Math.max(maxX, m.xMm)
    maxY = Math.max(maxY, m.yMm)
  }
  return {
    contractVersion: CONTRACT_VERSION,
    source: { kind: 'file', name, lineCount: moves.length },
    startMm: { xMm: 0, yMm: 0 },
    moves,
    passes: [{ index: 0, firstMove: 0, moveCount: moves.length }],
    bounds: { minXMm: minX, minYMm: minY, maxXMm: maxX, maxYMm: maxY },
    burnBounds: burn,
    diagnostics: [],
  }
}

/** Raster fill: one g1 per scan line, g0 to the next line's start. */
export function rasterJob(o: RasterOptions): JobModel {
  const moves: Move[] = []
  const laser = o.laser ?? 'm4'
  const lines = Math.max(1, Math.round(o.heightMm / o.intervalMm) + 1)
  let line = 1
  for (let i = 0; i < lines; i++) {
    const y = o.y0Mm + i * o.intervalMm
    const reverse = (o.bidirectional ?? true) && i % 2 === 1
    const xs = reverse ? o.x0Mm + o.widthMm : o.x0Mm
    const xe = reverse ? o.x0Mm : o.x0Mm + o.widthMm
    moves.push({ kind: 'g0', xMm: xs, yMm: y, feedMmPerMin: o.feedMmPerMin, s: 0, laser: 'off', line: line++ })
    moves.push({ kind: 'g1', xMm: xe, yMm: y, feedMmPerMin: o.feedMmPerMin, s: o.s, laser, line: line++ })
  }
  const yMax = o.y0Mm + (lines - 1) * o.intervalMm
  return job('raster', moves, { minXMm: o.x0Mm, minYMm: o.y0Mm, maxXMm: o.x0Mm + o.widthMm, maxYMm: yMax })
}

/** Closed square outline, counter-clockwise from (x0, y0). */
export function squareJob(x0Mm: number, y0Mm: number, sideMm: number, feedMmPerMin: number, s: number, laser: LaserMode = 'm4'): JobModel {
  const corners: [number, number][] = [
    [x0Mm + sideMm, y0Mm],
    [x0Mm + sideMm, y0Mm + sideMm],
    [x0Mm, y0Mm + sideMm],
    [x0Mm, y0Mm],
  ]
  const moves: Move[] = [{ kind: 'g0', xMm: x0Mm, yMm: y0Mm, feedMmPerMin, s: 0, laser: 'off', line: 1 }]
  corners.forEach(([x, y], i) => moves.push({ kind: 'g1', xMm: x, yMm: y, feedMmPerMin, s, laser, line: i + 2 }))
  return job('square', moves, { minXMm: x0Mm, minYMm: y0Mm, maxXMm: x0Mm + sideMm, maxYMm: y0Mm + sideMm })
}

/** Concatenate jobs' moves (each keeps its own line numbers offset to stay unique). */
export function concatJobs(...jobs: JobModel[]): JobModel {
  const moves: Move[] = []
  let offset = 0
  let burn: BoundsMm | null = null
  for (const j of jobs) {
    for (const m of j.moves) moves.push({ ...m, line: m.line + offset })
    offset += j.source.lineCount
    const b = j.burnBounds
    if (b)
      burn = burn
        ? {
            minXMm: Math.min(burn.minXMm, b.minXMm),
            minYMm: Math.min(burn.minYMm, b.minYMm),
            maxXMm: Math.max(burn.maxXMm, b.maxXMm),
            maxYMm: Math.max(burn.maxYMm, b.maxYMm),
          }
        : b
  }
  return job('combined', moves, burn)
}

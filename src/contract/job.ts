// Job model: the G-code parser's output (COD-263).
//
// The parser normalises everything the planner and core should not have to
// know about: G20 inches become mm, G91 relative moves become absolute, arcs
// (G2/G3) are flattened into G1 chords, and modal state (F, S, M3/M4/M5) is
// resolved onto every move. Z is ignored in v1.

import { Type, type Static } from '@sinclair/typebox'
import { BoundsMm, CONTRACT_VERSION, Diagnostic, Mm, NonNegative, UInt32, Vec2Mm, named } from './common.ts'

export const LaserMode = named(
  'LaserMode',
  Type.Union([Type.Literal('off'), Type.Literal('m3'), Type.Literal('m4')], {
    description: 'Spindle/laser state in effect: off (M5), m3 constant power, m4 dynamic power (scales with actual speed)',
  }),
)
export type LaserMode = Static<typeof LaserMode>

export const Move = named(
  'Move',
  Type.Object(
    {
      kind: Type.Union([Type.Literal('g0'), Type.Literal('g1')], {
        description: 'g0 rapid or g1 feed. GRBL laser mode ($32=1) keeps the beam off on g0 regardless of S.',
      }),
      xMm: Mm('Absolute end X'),
      yMm: Mm('Absolute end Y'),
      feedMmPerMin: NonNegative(
        'Modal F in effect (mm/min). Ignored for g0, which runs at the machine max rate ($110/$111).',
      ),
      s: NonNegative('Commanded S in effect, raw units (0..$30)'),
      laser: LaserMode,
      line: UInt32('1-based source line this move came from'),
      arc: Type.Optional(Type.Boolean({ description: 'true when this chord was flattened from a G2/G3 arc' })),
    },
    {
      description:
        'One straight move. Its start is the previous move end (or JobModel.startMm for the first move). The beam is on when kind = g1, laser != off and s > 0.',
      additionalProperties: false,
    },
  ),
)
export type Move = Static<typeof Move>

export const Pass = named(
  'Pass',
  Type.Object(
    {
      index: UInt32('0-based pass index'),
      firstMove: UInt32('Index into JobModel.moves of the first move in this pass'),
      moveCount: UInt32('Number of consecutive moves in this pass'),
      label: Type.Optional(Type.String({ description: 'Layer/pass name from sender comments, if any' })),
    },
    {
      description:
        'A contiguous range of moves. Passes tile JobModel.moves in order without gaps. v1 simulates all passes as one deposit (see COD-250 v1 simplifications).',
      additionalProperties: false,
    },
  ),
)
export type Pass = Static<typeof Pass>

export const JobSource = named(
  'JobSource',
  Type.Object(
    {
      kind: Type.Union([Type.Literal('file'), Type.Literal('network')], {
        description: 'file = opened from disk, network = streamed over the GRBL TCP emulator',
      }),
      name: Type.String({ description: 'File name, or sender-supplied name for network jobs' }),
      lineCount: UInt32('Number of source lines read'),
    },
    { additionalProperties: false },
  ),
)
export type JobSource = Static<typeof JobSource>

export const JobModel = named(
  'JobModel',
  Type.Object(
    {
      contractVersion: Type.Literal(CONTRACT_VERSION),
      source: JobSource,
      startMm: Vec2Mm,
      moves: Type.Array(Move),
      passes: Type.Array(Pass),
      bounds: BoundsMm,
      burnBounds: Type.Union([BoundsMm, Type.Null()], {
        description:
          'Bounds of beam-on moves only (null if nothing burns). Tiling and the fluence grid are sized from this, not the bed.',
      }),
      diagnostics: Type.Array(Diagnostic),
    },
    {
      description: 'Parser output. Coordinates absolute mm. Sent once per job in a job.loaded message.',
      additionalProperties: false,
    },
  ),
)
export type JobModel = Static<typeof JobModel>

/** True when a move deposits energy (independent of planner speed). */
export function beamOn(move: Move): boolean {
  return move.kind === 'g1' && move.laser !== 'off' && move.s > 0
}

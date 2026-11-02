// Native ↔ webview boundary (COD-250 decisions, COD-252 IPC results).
//
// Ownership:
//   Rust (aria-burn, GPLv3): GRBL TCP emulator and protocol, G-code parser,
//     planner, `?` status replies and `$` settings. It answers protocol traffic
//     itself; nothing on the protocol path waits on the webview.
//   TS core (aria-burn-core, MIT): deposit, blur, response kinds, outputs,
//     tiling, scrub. Runs in the webview on WebGL2 (CPU reference for tests).
//
// Transport: Tauri v2 Channels only, never one message per G-code line and
// never global events for streams.
//   - Event channel (Rust → webview): JSON `ChannelEvent` envelopes.
//   - Sample channel (Rust → webview): raw `ArrayBuffer` sample batches
//     (samples.ts). One batch per message, up to SAMPLE_BATCH_MAX_SAMPLES.
//   - Commands (webview → Rust): Tauri `invoke` with a `Command` argument.
// machine.status is pushed at STATUS_PUSH_HZ for the UI; LightBurn's `?` is
// answered by Rust from the same planner state.

import { Type, type Static } from '@sinclair/typebox'
import { CONTRACT_VERSION, NonNegative, Positive, UInt32, Vec2Mm, named } from './common.ts'
import { JobModel, LaserMode } from './job.ts'
import { MachineProfile } from './machine.ts'

export const STATUS_PUSH_HZ = 20

const JobId = UInt32('Job id assigned by Rust, unique for the app session')

export const MachineState = named(
  'MachineState',
  Type.Union(
    ['Idle', 'Run', 'Hold', 'Jog', 'Alarm', 'Door', 'Check', 'Home', 'Sleep'].map((s) => Type.Literal(s)),
    { description: 'GRBL machine state as reported in `?` status' },
  ),
)
export type MachineState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'

export const HelloEvent = named(
  'HelloEvent',
  Type.Object(
    {
      type: Type.Literal('hello'),
      contractVersion: Type.Literal(CONTRACT_VERSION),
      appVersion: Type.String(),
    },
    { description: 'First event on a new channel. The webview refuses a different contractVersion.', additionalProperties: false },
  ),
)

export const JobLoadedEvent = named(
  'JobLoadedEvent',
  Type.Object(
    { type: Type.Literal('job.loaded'), jobId: JobId, job: JobModel },
    {
      description:
        'Parsed job. File jobs: sent once after parsing. Network jobs: sent when the stream ends (samples flow live before it).',
      additionalProperties: false,
    },
  ),
)

export const PlanStartedEvent = named(
  'PlanStartedEvent',
  Type.Object(
    {
      type: Type.Literal('plan.started'),
      jobId: JobId,
      gridPitchMm: Positive('Pitch the planner used for its step limit (spot ÷ 3) (mm)'),
      dtMaxS: Positive('SAMPLE_DT_MAX_S in effect (s)'),
    },
    { description: 'Sample batches for jobId follow on the sample channel.', additionalProperties: false },
  ),
)

export const PlanDoneEvent = named(
  'PlanDoneEvent',
  Type.Object(
    {
      type: Type.Literal('plan.done'),
      jobId: JobId,
      durationS: NonNegative('Total job time including beam-off moves (s); the scrub timeline length'),
      batchCount: UInt32('Batches sent'),
      sampleCount: UInt32('Samples sent'),
      energyJ: NonNegative('Σ powerW × dtS over all samples (J, optical, before absorption); conservation check'),
    },
    { additionalProperties: false },
  ),
)

export const MachineStatusEvent = named(
  'MachineStatusEvent',
  Type.Object(
    {
      type: Type.Literal('machine.status'),
      state: MachineState,
      positionMm: Vec2Mm,
      feedMmPerMin: NonNegative('Actual feed (mm/min)'),
      s: NonNegative('Current S, raw units'),
      laser: LaserMode,
      line: UInt32('Source line being executed; 0 when idle'),
      jobId: Type.Union([JobId, Type.Null()]),
      tS: NonNegative('Job clock (s); 0 when no job'),
    },
    { description: 'Planner-accurate status, same data Rust uses to answer `?`.', additionalProperties: false },
  ),
)

export const ErrorEvent = named(
  'ErrorEvent',
  Type.Object(
    {
      type: Type.Literal('error'),
      code: Type.String({ minLength: 1 }),
      message: Type.String(),
      jobId: Type.Union([JobId, Type.Null()]),
    },
    { additionalProperties: false },
  ),
)

export const Event = named(
  'Event',
  Type.Union([HelloEvent, JobLoadedEvent, PlanStartedEvent, PlanDoneEvent, MachineStatusEvent, ErrorEvent], {
    description: 'Rust → webview event, tagged by `type`.',
  }),
)
export type Event = Static<typeof Event>

export const ChannelEvent = named(
  'ChannelEvent',
  Type.Object(
    {
      seq: UInt32('Per-channel sequence number, starts at 0, +1 per message; a gap means a dropped message'),
      event: Event,
    },
    { description: 'JSON envelope on the event channel.', additionalProperties: false },
  ),
)
export type ChannelEvent = Static<typeof ChannelEvent>

export const Command = named(
  'Command',
  Type.Union(
    [
      Type.Object({ type: Type.Literal('job.open'), path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('machine.setProfile'), profile: MachineProfile }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('plan.start'), jobId: JobId }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('plan.cancel'), jobId: JobId }, { additionalProperties: false }),
      Type.Object(
        {
          type: Type.Literal('emulator.set'),
          enabled: Type.Boolean(),
          port: Type.Integer({ minimum: 1, maximum: 65535, description: 'TCP port on localhost' }),
        },
        { additionalProperties: false },
      ),
    ],
    { description: 'Webview → Rust command, sent as the single argument of a Tauri invoke.' },
  ),
)
export type Command = Static<typeof Command>

// SPDX-License-Identifier: MIT
// Live (network) job tracking per contract live.ts: consumes the event and
// sample channels for one job, keeps running stats, the growing setup with
// lattice tiles, the live scrub head, and which tiles new samples touched.

import {
  decodeSampleBatch,
  liveHeadS,
  liveScrubCutoffS,
  type Event,
  type JobModel,
  type LiveJobStats,
  type MachineProfile,
  type MaterialProfile,
  type Tile,
} from '../contract/index.ts'
import { setupJob, type SetupOptions, type SimSetup } from './job.ts'
import { SampleStore } from './sample-store.ts'

export class LiveJob {
  readonly store: SampleStore
  streaming = true
  plannedS = 0
  lineCount = 0
  durationS: number | null = null
  job: JobModel | null = null

  constructor(
    readonly jobId: number,
    readonly name: string,
    readonly machine: MachineProfile,
    readonly material: MaterialProfile,
    private readonly options: Omit<SetupOptions, 'tiling'> = {},
  ) {
    this.store = new SampleStore(jobId)
  }

  /** Feed every event from the event channel; events for other jobs are ignored. */
  onEvent(event: Event): void {
    if (!('jobId' in event) || event.jobId !== this.jobId) return
    switch (event.type) {
      case 'job.progress':
        this.plannedS = Math.max(this.plannedS, event.plannedS)
        this.lineCount = event.lineCount
        break
      case 'job.loaded':
        this.job = event.job
        this.lineCount = event.job.source.lineCount
        break
      case 'plan.done':
        this.durationS = event.durationS
        this.plannedS = Math.max(this.plannedS, event.durationS)
        this.streaming = false
        break
    }
  }

  /** Feed every buffer from the sample channel. */
  onBatch(buffer: ArrayBuffer): void {
    const batch = decodeSampleBatch(buffer)
    if (batch.jobId === this.jobId) this.store.append(batch)
  }

  headS(): number {
    return this.durationS ?? liveHeadS(this.plannedS, this.store.sampledUntilS)
  }

  cutoffS(progress: number, follow: boolean): number {
    return liveScrubCutoffS(progress, this.headS(), follow)
  }

  /**
   * Current setup: lattice tiles while streaming, the regular plan once
   * job.loaded has arrived. Null until something burns. On the GPU, pass the
   * result through GlSim.fit() so live tiles fit the byte budget (BURN-36);
   * `maxTileCells` overrides the constructor's.
   */
  setup(maxTileCells?: number): SimSetup | null {
    const bounds = this.job ? this.job.burnBounds : this.store.burnBounds
    if (!bounds) return null
    const options: SetupOptions = { ...this.options, tiling: this.job ? 'regular' : 'live' }
    if (maxTileCells !== undefined) options.maxTileCells = maxTileCells
    return setupJob(bounds, this.machine, this.material, options)
  }

  stats(): LiveJobStats {
    const setup = this.setup()
    return {
      jobId: this.jobId,
      name: this.name,
      streaming: this.streaming,
      headS: this.headS(),
      lineCount: this.lineCount,
      batchCount: this.store.batchCount,
      sampleCount: this.store.count,
      energyJ: this.store.energyJ,
      missingBatches: [...this.store.missingSequences],
      burnBounds: this.store.burnBounds,
      grid: setup ? { width: setup.grid.width, height: setup.grid.height, pitchMm: setup.grid.pitchMm } : null,
      tileCols: setup?.plan.cols ?? 0,
      tileRows: setup?.plan.rows ?? 0,
      tileCount: setup?.plan.tiles.length ?? 0,
    }
  }

  /** Tiles of `setup` whose padded rect received samples [fromSample, store.count). */
  dirtyTiles(setup: SimSetup, fromSample: number): Tile[] {
    const { grid, plan } = setup
    const dirty = new Set<Tile>()
    const xye = this.store.xye
    for (let s = fromSample; s < this.store.count; s++) {
      const cx = (xye[s * 3]! - grid.originXMm) / grid.pitchMm
      const cy = (xye[s * 3 + 1]! - grid.originYMm) / grid.pitchMm
      for (const t of plan.tiles) {
        const p = t.padded
        // ±1 cell for the bilinear footprint.
        if (cx >= p.x - 1 && cx < p.x + p.width + 1 && cy >= p.y - 1 && cy < p.y + p.height + 1) dirty.add(t)
      }
      if (dirty.size === plan.tiles.length) break
    }
    return [...dirty]
  }
}

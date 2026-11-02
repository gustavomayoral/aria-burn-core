# Core simulation pipeline (COD-264)

The baseline simulator from the COD-250 model, implemented against the v1
contract in `src/contract/`. Code is in `src/sim/`; the WebGL2 path is in
`src/sim/gl/`, and the CPU reference it is checked against is `src/sim/cpu.ts`.

```
JobModel ─▶ MotionSampler ─▶ sample batches ─▶ SampleStore ─▶ per tile: deposit ─▶ blur H ─▶ blur V ─▶ response ─▶ colour / depth / verdict
            (interim now,     (binary, same    (xye, t, line)                                                    ├▶ overview (UI canvas)
             COD-255 later)    as the Channel)                                                                     └▶ CellReader (hover)
```

## Stages

| Stage | Module | Rule |
|---|---|---|
| Profiles | `profiles.ts` | Loaded from JSON data files and validated with the TypeBox schemas plus `checkMaterialProfile` / `checkMachineProfile`. Nothing is hard-coded. |
| Sampling | `sampler.ts` | **Interim** trapezoid sampler behind `MotionSampler`, written from scratch (not GRBL; the COD-255 port is GPLv3 in aria-burn). Per move it uses the axis-limited accel and max rate along the move direction. The junction speed is `min(v_a, v_b)·max(0, cos θ)`, followed by backward and forward feasibility passes. Each constant-acceleration block is split into equal-time intervals and sampled at the interval midpoints, per `samples.ts`. Output is byte-identical to the planner's channel batches. |
| Power | contract `opticalPowerW` | M3 is constant. M4 scales S by actual ÷ programmed speed before the S → power curve. |
| Store | `sample-store.ts` | Interleaved `[x, y, power·dt]` f32 (uploaded to the GPU as-is), f64 times, and source lines. A time cutoff is a prefix. Batch sequence gaps are recorded. |
| Deposit | `cpu.ts` `depositCpu`, `gl/shaders.ts` `DEPOSIT_VS` | `E·absorption / pitch²`, split bilinearly over the four nearest cell centres. On the GPU each sample is one instance of four 1-pixel points on exact cell centres, added into R32F with `EXT_float_blend`. Without that extension the CPU deposit is uploaded instead. Pitch = minor spot σ ÷ 3. |
| Blur | `kernel.ts`, `BLUR_FS` | Separable Gaussian, `σ_total = √(σ_spot² + σ_heat²)` per axis. Truncated at 3σ, normalised by the discrete sum, zero outside the tile. It runs along machine X then Y. That is exact for machine-aligned spots (the provisional diode is at 90°). For rotated spots it keeps the X/Y variances and drops the correlation; the rotated kernel is COD-256. |
| Response | `response.ts`, `RESPONSE_FS` | **char**: tone ramp `((F−start)/(end−start))^γ`, Lab lerp, depth above the ablation threshold. **melt**: frost ramp and depth above removal. A polished edge (F ≥ frostFull, below removal, with a 4-neighbour at or above removal) shows the base colour. **bleach**: mark ramp, depth always 0. Lab (D65) → sRGB8 per cell. |
| Verdict | contract `classifyFluence`, `RESPONSE_FS` | Per-cell bucket (untouched / under / in range / over / fire risk) in an R8UI target. |
| Hover | `readout.ts` `CellReader` | Contract `CellReadout` computed on demand from the samples near the cell (bucket index), rather than read back from tiles. It is exact against the grid pipeline, works at any zoom and cutoff, and reports the top contributing source lines. |
| Canvas | `GlOverview` | Each tile's colour (box-filtered) and worst verdict are composited into a ≤ 4096² overview texture, which is then blitted to the canvas. The full-res tile outputs are passed to `onTile` while still resident, for zoomed views (COD-259). |

## Tiling

- Regular jobs use contract `planTiles`. Padded tiles are ≤ 9000², and the margin is the kernel radius.
- Each tile deposits only what lands in its padded rect, blurs, and keeps its core. Tiled output is bit-identical to untiled on the GPU, and within 1e-5 of peak on the CPU (`sim.test.ts`, bench).
- Render targets are pooled at the largest padded size and reused across tiles and runs. Full-res and coarse use separate pools, so scrubbing never evicts the full-res targets (COD-252: reallocating them stalled the driver).
- **Bins.** With more than one tile, samples are counting-sorted into 512-cell buckets on an absolute mm lattice. Each bucket stays in time order, so a cutoff is still a prefix of every bucket. A tile draws only the buckets overlapping its padded rect (`bins.ts`).

## Progressive scrub

- **Coarse grid.** `coarseGrid` / `coarseKernel` from the contract: ≤ 1024 cells per side, and the kernel widens to at least 1 coarse cell. Fluence is conserved because a coarse cell stores energy ÷ coarse pitch².
- **Checkpoints.** Coarse deposit uses up to 16 checkpoints: checkpoint *i* holds the deposit of samples `[0, (i+1)·spacing)`. A scrub step copies the nearest checkpoint below the cutoff and deposits at most `spacing` samples. They are built on the first coarse pass, and stay valid while a live job appends samples (until its grid changes).
- **Release.** On release, the full-res tiled pass runs at the same cutoff.

## Live (network) jobs

New in the contract (additive):

- **`job.streaming`** `{ jobId, name }` marks a network job that started streaming.
- **`job.progress`** `{ jobId, plannedS, lineCount, batchCount, sampleCount, energyJ }` gives running totals at ≤ `JOB_PROGRESS_HZ` (10 Hz). It is sent after the batches it counts.
- **Order:** `job.streaming` → `plan.started` → batches + `job.progress` → `job.loaded` → `plan.done`.

The normative rules are in `src/contract/live.ts`:

- **Live grid.** `planJobGrid` over the burn bounds received so far. It is lattice-aligned, so existing cells never move as the grid grows.
- **Live tiling.** `planLiveTiles`: tiles on a fixed absolute lattice (core `C = 9000 − 2·margin` cells), created lazily as the grid reaches them, and never moved. A refresh re-runs only `LiveJob.dirtyTiles`. After `job.loaded` the job switches to `planTiles`.
- **Live scrub.** `headS = max(plannedS, end of last sample)`, and `cutoff = progress × headS`. Follow live pins the cutoff to `headS`.
- **Job panel.** `LiveJob.stats()` returns `LiveJobStats`: bounds, grid, tile count, totals and missing batches.

`src/sim/live.ts` (`LiveJob`) consumes both channels for one job.

## Performance (COD-251/252 criteria)

See `docs/bench/cod-264-macos-m1.txt`, from `pnpm bench` in the Claude app's Chromium (ANGLE/Metal, Apple M1).

| COD-252 job (σ 0.05 mm, 6000², 5.9 M samples) | Result | Criterion |
|---|---|---|
| Full-res, warm median | 93 ms | < 2 s ✅ |
| Coarse scrub, warm median (moving cutoff) | 3.5 ms | < 50 ms ✅ |
| Fluence, every stage, full and coarse | 0.9999–1.0000 | within 1% ✅ |
| GPU vs CPU, tiled vs untiled | 1e-6 of peak, Δcolour ≤ 1, 0 verdict mismatches | ✅ |

**Not yet measured:** the Tauri WKWebView and Windows/Iris Xe. COD-252 measured Iris Xe at about 1.6× the macOS full-res time, with sync overhead on top.

**Finding: the provisional diode's pitch.** The 10 W profile (σ 0.03 × 0.015 mm) gives a 5 µm pitch, so a 100 mm job is 20012² cells in 9 tiles (11× the spike's cells) and 19.7 M samples. Results on the M1:

- Full-res: 1.26 s warm. Blur is about 0.8 s of that, and the first run is 4.0 s.
- Coarse scrub: 14 ms median.

Iris Xe will very likely exceed 2 s on this job. The options need a decision outside this issue:

- base the pitch on σ_total (heat included) rather than σ_spot,
- use a per-axis pitch,
- refresh full-res tile by tile with the coarse image underneath.

## Commands

```sh
pnpm check   # typecheck + tests (CPU reference, tiling seams, scrub, live, goldens)
pnpm bench   # serve bench/ (WebGL2), open http://localhost:5199 and click Run benchmark
```

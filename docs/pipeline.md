# Core simulation pipeline (COD-264, thermal step COD-258)

The baseline simulator from the COD-250 model, implemented against the v1
contract in `src/contract/`. Code is in `src/sim/`; the WebGL2 path is in
`src/sim/gl/`, and the CPU reference it is checked against is `src/sim/cpu.ts`.

```
JobModel ─▶ MotionSampler ─▶ sample batches ─▶ SampleStore ─▶ thermal step ─▶ per tile: deposit ─▶ blur H ─▶ blur V ─▶ response ─▶ colour / depth / verdict
            (interim now,     (binary, same    (xye, t, line,  (once per job,   (dose energies                                     ├▶ overview (UI canvas)
             COD-255 later)    as the Channel)  dt, speed)      if the material   with a thermal                                     └▶ CellReader (hover)
                                                                has a model)      model)
```

## Stages

| Stage | Module | Rule |
|---|---|---|
| Profiles | `profiles.ts` | Loaded from JSON data files and validated with the TypeBox schemas plus `checkMaterialProfile` / `checkMachineProfile`. Nothing is hard-coded. Catalog machines (BURN-30) are a `MachineFrame` plus a `LaserModule` from `src/profiles/catalog/`, combined by `combineMachine` (`loadCatalogMachine`) into the same `MachineProfile`. |
| Sampling | `sampler.ts` | **Interim** trapezoid sampler behind `MotionSampler`, written from scratch (not GRBL; the COD-255 port is GPLv3 in aria-burn). Per move it uses the axis-limited accel and max rate along the move direction. The junction speed is `min(v_a, v_b)·max(0, cos θ)`, followed by backward and forward feasibility passes. Each constant-acceleration block is split into equal-time intervals and sampled at the interval midpoints, per `samples.ts`. Output is byte-identical to the planner's channel batches. |
| Power | contract `opticalPowerW` | M3 is constant. M4 scales S by actual ÷ programmed speed, then the machine profile's `powerCurve` maps S to optical power, linear between points (COD-256). The provisional diode curve has a dead zone below S 5% and a convex knee up to S 20% (COD-266, provisional). |
| Store | `sample-store.ts` | Interleaved `[x, y, power·dt]` f32 (uploaded to the GPU as-is), f64 times, source lines, and per-sample `dt` and speed (for the thermal step). A time cutoff is a prefix. Batch sequence gaps are recorded. |
| Thermal | `thermal.ts`, `gl/gl-thermal.ts` | Only for materials with `thermal.kind = peakTemperature` (COD-258, below). Per-sample absorbed energy (char raises absorption) and dose energy, plus the bulk-temperature map. Runs once per job and material; every tile, the scrub and the hover reuse it. |
| Deposit | `cpu.ts` `depositCpu`, `gl/shaders.ts` `DEPOSIT_VS` | `E·absorption / pitch²`, split bilinearly over the four nearest cell centres. On the GPU each sample is one instance of four 1-pixel points on exact cell centres, added into R32F with `EXT_float_blend`. Without that extension the CPU deposit is uploaded instead. Detail pitch = minor spot σ ÷ 3; the job grid may use an integer multiple of it (Job pitch, below). |
| Blur | `kernel.ts`, `BLUR_FS`, `SKEW_BLUR_FS` | Elliptical Gaussian (COD-256), `σ_total = √(σ_spot² + σ_heat²)` per spot axis, rotated by `spot.angleDeg`. Truncated at 3σ, normalised by the discrete sum, zero outside the tile. It runs along machine X, then along Y. For machine-aligned spots (the provisional diode is at 90°) that is a plain separable blur at unchanged cost. For a rotated spot the Y pass is sheared (contract `shearedKernel`): row offset t reads at `x + shear·t`, split linearly over two cells, and the X pass is narrowed by the split's variance. The full covariance, including the X–Y term, is reproduced. The sheared pass does two fetches per tap, so it costs about 1.5× an aligned blur. |
| Response | `response.ts`, `RESPONSE_FS` | With a thermal model every rule below reads **thermal dose** instead of fluence (same thresholds), and the GPU tiles hold dose. **char**: tone ramp `((F−start)/(end−start))^γ`, Lab lerp, depth above the ablation threshold. **melt**: frost ramp and depth above removal. A polished edge (F ≥ frostFull, below removal, with a 4-neighbour at or above removal) shows the base colour. **bleach**: mark ramp, depth always 0. Lab (D65) → sRGB8 per cell. |
| Verdict | contract `classifyFluence` / `classifyThermal`, `RESPONSE_FS` | Per-cell bucket (untouched / under / in range / over / fire risk) in an R8UI target. With a thermal model, fire risk is the bulk temperature at or above `fireRisk.thresholdK`. |
| Hover | `readout.ts` `CellReader` | Contract `CellReadout` computed on demand from the samples near the cell (bucket index), rather than read back from tiles. It is exact against the grid pipeline, works at any zoom and cutoff, and reports the top contributing source lines. |
| Canvas | `GlOverview` | Each tile's colour (box-filtered) and worst verdict are composited into a ≤ 4096² overview texture, which is then blitted to the canvas. The full-res tile outputs are passed to `onTile` while still resident, for zoomed views (COD-259). |

## Thermal step (COD-258, Option B)

Normative rules: `src/contract/thermal.ts`. In short:

- **Why two scales.** Linear conduction with the COD-266 constants puts the flash of a normal diode
  engrave at about 10⁴ K: real surfaces are capped there by pyrolysis and ablation, which no published
  constant describes. So the surface temperature where a sample lands is split at a lag τ (20 ms):
  - **bulk**: heat older than τ, from a coarse thermal grid with physical k and ρc;
  - **flash**: the pass itself, as a moving-Gaussian-source integral on a semi-infinite solid.
- **Bulk grid.** Pitch 0.1 mm (coarsened to ≤ 256² cells). Four depth layers (¼ pitch thick, each next
  4× thicker). Per time bin (10 ms, coarsened to ≤ 1024 bins): an exact Gaussian lateral step and an
  implicit depth step. Mirror edges and an insulated top and bottom, so Σ ρc·ΔT·V is the injected energy.
  Each bin is injected `lagBins` later, already spread to its age τ in depth and laterally.
- **Flash.** `flashSpeedFactor(v, φ)` is the integral's peak per unit centre-line fluence, 1 at
  `referenceSpeedMmPerS` along +X. It is ∝ √v for fast passes and lower along the spot's long axis.
  Its absolute scale is calibrated: `(rampOnsetK − ambientK) ÷ rampStart` K per J/mm².
- **Dose.** Each sample's absorbed energy is weighted by
  `w = flash factor + bulk · v·√(2π)·σ⊥ / (flashK · a · P)`. Dose goes through the same deposit and
  blur as fluence, and every fluence threshold applies to it. A cold reference pass has dose =
  fluence. A slower pass at the same fluence gets less, and preheated material gets more.
- **Absorption feedback.** For char with `absorptionAtFullChar`, absorption follows the tone ramp of
  the dose accumulated on the thermal grid.
- **Outputs.** `dose`, `peakTemperatureK` (ambient + flashK · dose, the equivalent single-pass peak)
  and `bulkTemperatureK` (the hottest preheat a pass met there; fire risk compares this).
- **Seam for Option A.** `ThermalStep` (`thermal.ts`) turns samples into per-sample `eAbs` / `eDose`
  plus an optional bulk map. An empirical speed correction implements it with no grid
  (`thermal.test.ts` has a stand-in). Pass it as `setupJob(…, { thermalStep })`.
- **Scrub.** Weights depend only on earlier samples, so one run serves every cutoff. The coarse scrub
  deposits the same dose energies, and the issue's scrub question goes away.
- **Live jobs (BURN-35).** While a job streams, the setup's live tiling selects the live thermal plan
  (`planLiveThermal`): the grid over the bounds rounded out to blocks of about span ÷ 8, and `binS` a
  power-of-two multiple of 10 ms. It stays the same over many refreshes, so `thermalFor` continues the
  cached result (`ThermalStep.extend`) from a snapshot taken at the start of the last bin, over the new
  bins only. It reruns in full when that plan changes, the machine, material or kernel changes, a batch
  goes missing, or `job.loaded` switches to the job plan. The continued result equals a full run under
  the same plan (bit for bit on the CPU, `thermal-live.test.ts`).

**Synthetic acceptance (`src/sim/thermal.test.ts`, CPU reference):**

- equal-fluence pairs (200 → 25 mm/s at constant fluence) give strictly falling peak temperature and dose;
- a 1.5 mm fill heats ≥ 100 K more than a 12 mm fill at the same settings, with more dose;
- energy is conserved through the grid (1e-4), and fluence and dose through deposit and blur (1 %);
- bulk temperature and dose weights converge as thermal pitch and bins shrink (0.2 mm / 20 ms → 0.05 mm / 5 ms, against a 0.025 mm / 2.5 ms reference);
- fire risk triggers on a hot small fill, not on a normal one;
- a second pass over charred wood absorbs more.

**Known limits** (also in the contract header):

- A neighbouring line that passes within τ (20 ms) of a sample counts in neither term. Only very short,
  very fast lines are affected.
- While streaming, the live plan's rounded extents can make its thermal pitch up to 1.5× the job plan's
  (about 1.1× for the 100 mm bench raster once it is complete), and each plan change (up to about eight per
  doubling of the job's extent, one per doubling of its duration) costs one full rerun.
- Without `EXT_float_blend`, the CPU reference runs the thermal step. That is slow for big jobs.

## Tiling

- Regular jobs use contract `planTiles`. The margin is the kernel radius.
- **Tile budget (BURN-36).** The padded tile side comes from a GPU byte budget, not a fixed 9000²: a tile pool is 17 bytes a cell (2 × R32F, RGBA8, R32F, R8UI), and the samples, bins, thermal per-sample energies (~28 B a sample together) and overviews stay resident beside it. `GlSim.fit(store, setup, overview)` allocates those first and replans the setup so `pool ≤ budget − everything else`, between `TILE_MIN_CELLS` (1024) and the 9000 hard cap. Every allocation made through `gl-util` is counted in a per-context ledger (`ledger(gl).total`).
- **Budget per GPU.** WebGL can't query GPU memory, so the default is by renderer: 768 MiB on Intel integrated GPUs, 1.5 GiB elsewhere (`defaultGpuBudgetBytes`). On Iris Xe it is a speed setting, not a memory limit: every pool up to 9000² allocates, but at 5 µm 768 MiB (21 × 21 tiles) renders ~3× faster than 1536 MiB (3 × 3).
- **Smaller-tile fallback.** If a pool still fails (`FRAMEBUFFER_UNSUPPORTED` or `OUT_OF_MEMORY` → `GlAllocationError`), the run retries at about half the pool bytes and remembers the side that worked for that GPU. `GlRunResult.plan` / `replanned` say what ran. A refusal that comes with a lost context is a lost context, not a size limit: on Iris Xe / WebView2 a 993² pool failed that way while 9000² pools allocate (`burn-36-tiles-windows-irisxe.txt`). The loss can surface after the failing call, so failure paths check `contextGone()` (finish + `getError()` = `CONTEXT_LOST_WEBGL`).
- **Context loss.** `watchContextLoss(canvas, { onLost, onRestored }, gl)` prevents the default so the browser restores the context, and clears that context's GPU ledger on loss so the dead objects' bytes don't shrink the tile budget after restore. Runs on a lost context throw `GlContextLostError`. On restore, build new `GlSim` / `GlOverview` / `GlBurnView` and re-run: all GPU state is derived.
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
- **Live tiling.** `planLiveTiles`: tiles on a fixed absolute lattice (core `C = S − 2·margin` cells, `S` the budgeted tile side: pass the setup through `GlSim.fit`), created lazily as the grid reaches them, and never moved while `S` holds. A refresh re-runs only `LiveJob.dirtyTiles`. After `job.loaded` the job switches to `planTiles`.
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

**Rotated spot (COD-256).** The bench's GPU-vs-CPU job with the provisional spot turned to 30° gives:

- GPU vs CPU: 1.2e-6 of peak, Δcolour ≤ 1, 0 verdict mismatches.
- Energy: 1.0000 at every stage.
- Blur H+V: 7.0 ms median, against 5.1 ms for the same spot axis-aligned (1440², M1).

Axis-aligned spots, including every current profile, run the unchanged separable blur.

**Thermal step (COD-258).** See `docs/bench/cod-258-macos-m1.txt` (Thermal step button):

| 100 × 100 mm raster, 1121 s job | σ 0.05 mm (5.9 M samples) | provisional diode, 5 µm (19.7 M samples) |
|---|---|---|
| Thermal step, once per job/material | 2.0 s (GPU loop 0.55 s, CPU statics 0.25–1.4 s) | 2.0 s (GPU loop 0.9 s, statics ~1 s) |
| Full-res, warm (fluence only → with thermal) | 102 → 103 ms | 1316 → 1269 ms (noise) |
| Coarse scrub, warm median | 4.5 ms | 13 ms |
| GPU vs CPU thermal | per-sample energy 2e-4, 0 verdict mismatches | — |
| Dose energy, every stage | 1.0000 | 1.0000 |

A full-res run deposits dose instead of fluence (same R32F targets, same passes), so warm runs and
scrubbing cost the same. The new cost is the one-time thermal step. Bin and cell budgets
(`THERMAL_MAX_BINS`, `THERMAL_MAX_CELLS`, `THERMAL_MAX_CELL_BINS`) bound it for long jobs. Below
about 10 s of job time it is 10 ms bins at 0.1 mm. On the M1 the per-bin cost is mostly pass
overhead (about 0.5 ms for 7 passes), so the bin budget sets the cost. Iris Xe is not measured.

**Not yet measured:** the Tauri WKWebView and Windows/Iris Xe. COD-252 measured Iris Xe at about 1.6× the macOS full-res time, with sync overhead on top.

**Finding: the provisional diode's pitch.** The 10 W profile (σ 0.03 × 0.015 mm) gives a 5 µm pitch, so a 100 mm job is 20012² cells in 9 tiles (11× the spike's cells) and 19.7 M samples. On the M1 that was 1.26 s warm (blur ~0.8 s) and 4.0 s cold, and Iris Xe would take an estimated 8–15 s. BURN-37 settles it with a job cell budget (next section).

## Job pitch (BURN-37)

Normative rules: `src/contract/tiling.ts` (`jobPitchMm`) and `deposit.ts` (`coarsePitchKernel`). In short:

- **Two pitches.** σ_min ÷ 3 is the **detail pitch**. The **job grid** (full-res overview, scrub, tiles) uses `k ×` detail pitch, with `k` the smallest integer that keeps `planJobGrid` within the **job cell budget**. Integer `k` nests the lattices: a job cell is exactly `k × k` detail cells.
- **Budget per GPU.** By renderer, like the byte budget: 50 M cells on Intel integrated GPUs, 256 M elsewhere (`defaultJobCellBudget`, `GlSim.cellBudget`). Pass it as `setupJob(…, { cellBudget: sim.cellBudget })`; without it (CPU reference, tests) `k = 1`. The 5 µm 100 mm job gets `k = 3` (15 µm, 44.6 M cells, one tile) on Iris Xe and `k = 2` (10 µm, 100 M cells) on the M1.
- **Detail view.** `runDetail` runs at the detail pitch on `detailSetup(setup)`, the same job planned at the detail pitch. Its `rect` is in `detailGrid(setup)` cells: pass that grid to `visibleCells`. Spatial bins are bucketed on the detail pitch, so full and detail runs share them.
- **Live jobs** size `k` from the machine's travel area, so the pitch never changes while the bounds grow.
- **Blur compensation.** The bilinear deposit spreads each sample by pitch²/6 of variance per axis, so a coarser grid widens lines. The job grid's kernel gives back `(pitch² − detailPitch²)/6` per axis (`coarsePitchKernel`). At `k = 1` nothing changes, and the golden images are untouched.

**Accuracy cost** (`scripts/burn-37-accuracy.ts`, CPU reference against `k = 1`, provisional diode, all three materials; `docs/bench/burn-37-accuracy-cpu.txt`, and `-uncompensated.txt` without the kernel correction):

| k (pitch) | energy, every stage | line σ | peak vs `k = 1` box-averaged | fluence error p99 (of peak) | verdict differs (marked cells) | verdict edge shift, mean |
|---|---|---|---|---|---|---|
| 2 (10 µm) | 0.9999–1.0000 | +0.4 % | −0.2 to 0 % | 0.1–0.3 % | 2.1–2.8 % | 5 µm |
| 3 (15 µm) | 0.9998–1.0000 | −0.1 to +0.3 % | +1.3 to +1.7 % | 0.7–1.2 % | 0.7–1.5 % | 5–5.5 µm |
| 4 (20 µm) | 0.9998–1.0000 | +1.8 to +2.0 % | −0.3 to +0.1 % | 0.4–0.7 % | 0.8–4.0 % | 5–6 µm |

- Edge cells are where verdicts differ, and the mean shift is one detail cell. Without the compensation, line width grows by 1.4 % at `k = 3` and 4.4 % at `k = 4`, with a peak up to −3.5 %.
- Melt's polished edge is one cell wide, so at `k > 1` it is `k` detail cells wide in the overview (colour Δ up to 97 on those cells). The detail view shows it at the detail pitch.
- Once the job pitch passes σ_total minor (~19 µm for birch, `k ≥ 4`), single lines lose a few % of their peak to cell sampling. On Iris Xe that starts at jobs over ~105 mm square (7071 cells × 15 µm).

**Performance** (`docs/bench/burn-37-pitch-macos-m1.txt`, bench button "Job pitch (BURN-37)", 5 µm 100 mm raster, birch with thermal, M1):

| Budget | Job pitch | Cells | Warm full-res (median) |
|---|---|---|---|
| none | 5 µm | 401 M | 1989 ms |
| M1 default, 256 M | 10 µm | 100 M | 406 ms |
| Iris Xe, 50 M | 15 µm | 44.6 M | 238 ms |

- A detail run of 1920 × 1080 cells at 5 µm takes ~11 ms while panning.
- The first detail run takes 1.4 s, because it bins all 19.7 M samples (a one-tile job grid never needs bins).
- Iris Xe is not measured yet.

## Commands

```sh
pnpm check   # typecheck + tests (CPU reference, tiling seams, scrub, live, goldens)
pnpm bench   # serve bench/ (WebGL2), open http://localhost:5199 and click Run benchmark
pnpm tsx scripts/burn-37-accuracy.ts   # coarse job pitch vs the detail pitch (CPU)
```

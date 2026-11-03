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
| Profiles | `profiles.ts` | Loaded from JSON data files and validated with the TypeBox schemas plus `checkMaterialProfile` / `checkMachineProfile`. Nothing is hard-coded. |
| Sampling | `sampler.ts` | **Interim** trapezoid sampler behind `MotionSampler`, written from scratch (not GRBL; the COD-255 port is GPLv3 in aria-burn). Per move it uses the axis-limited accel and max rate along the move direction. The junction speed is `min(v_a, v_b)·max(0, cos θ)`, followed by backward and forward feasibility passes. Each constant-acceleration block is split into equal-time intervals and sampled at the interval midpoints, per `samples.ts`. Output is byte-identical to the planner's channel batches. |
| Power | contract `opticalPowerW` | M3 is constant. M4 scales S by actual ÷ programmed speed, then the machine profile's `powerCurve` maps S to optical power, linear between points (COD-256). The provisional diode curve has a dead zone below S 5% and a convex knee up to S 20% (COD-266, provisional). |
| Store | `sample-store.ts` | Interleaved `[x, y, power·dt]` f32 (uploaded to the GPU as-is), f64 times, source lines, and per-sample `dt` and speed (for the thermal step). A time cutoff is a prefix. Batch sequence gaps are recorded. |
| Thermal | `thermal.ts`, `gl/gl-thermal.ts` | Only for materials with `thermal.kind = peakTemperature` (COD-258, below). Per-sample absorbed energy (char raises absorption) and dose energy, plus the bulk-temperature map. Runs once per job and material; every tile, the scrub and the hover reuse it. |
| Deposit | `cpu.ts` `depositCpu`, `gl/shaders.ts` `DEPOSIT_VS` | `E·absorption / pitch²`, split bilinearly over the four nearest cell centres. On the GPU each sample is one instance of four 1-pixel points on exact cell centres, added into R32F with `EXT_float_blend`. Without that extension the CPU deposit is uploaded instead. Pitch = minor spot σ ÷ 3. |
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
- Live jobs rerun the whole thermal step whenever the store grows. An incremental run is a follow-up.
- Without `EXT_float_blend`, the CPU reference runs the thermal step. That is slow for big jobs.

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

# Photo fit (BURN-15)

A user fits a material's parameters to their own laser and material batch from
one photographed test grid. The grid comes from the BURN-32 generator
(`generatePattern('grid', …)`), burned and photographed next to the printed
Aria Burn reference card. Everything below lives in `src/calibration/` and is
exported from `aria-burn-core/calibration`; the app decodes the photo and runs
the UI.

## Pipeline

1. **Card** (`card.ts`, `detect.ts`). Our own card: 24 patches (neutrals, wood
   tones, saturated colours) inside a 3 mm black frame on white paper
   (`referenceCard()`, printable with `cardSvg()`). Detection: dark-relative-to-
   local-mean mask, connected components, a ring-shaped component with a light
   hole whose hull is a quadrilateral, corners refined by fitting a line to
   each outer edge. The rotation is chosen by which of the four orders gives
   the best colour correction (the patches are asymmetric).
2. **Pattern** (`detect.ts`). The four 3 mm corner fiducials and the half-size
   orientation square, marked darker (char) or lighter (melt, bleach) than the
   bare material, at the scale the card gives. Of the candidate fours, the one
   whose homography puts the orientation square where it belongs and that
   encloses every other mark wins. Either step can be replaced by corners
   placed by hand (`AnalyseOptions.cardCorners`, `fiducials`).
3. **Light and colour** (`photo.ts`). Flat field: log luminance = level +
   plane, with one level for the card's bare-paper ring and one for the bare
   material around the grid. Then an affine 3 × 4 map from flat-fielded
   camera linear RGB to the patches' reference linear sRGB. Clipped pixels
   (sRGB8 ≥ 253) are left out; an overexposed card falls back to the
   material ring for the light gradient and warns.
4. **Cells** (`photo.ts`). Each cell's inner region (inset 20 % from every
   edge), sampled on a 20 × 20 grid through the homography, luminance-trimmed
   mean in linear light, corrected, converted to Lab once. The bare material
   ring gives the base colour.
5. **Forward model** (`forward.ts`). The core's own CPU deposit and blur at
   10 µm over each cell's inner region, from the job's samples (the app's
   planner, or the core sampler). With a peakTemperature model, one thermal
   run is split per sample into a flash part and a bulk part at flashK = 1, so
   dose(θ) = D_flash + D_bulk / flashK(θ) exactly for any ramp start and
   rampOnsetK (contract thermal.ts: flashK = (rampOnsetK − ambient) ÷
   rampStart, bulkGain ∝ 1 / flashK). With absorption feedback the fit reruns
   the thermal step at the fitted parameters and refits (fixed point, ≤ 3 runs).
6. **Fit** (`fit.ts`). Levenberg–Marquardt on per-cell Lab residuals (the
   prediction averages each cell in linear light through a 256-bin histogram
   of the ramp position), with weak priors at the starting profile so
   parameters the grid can't see stay put and are reported as such.
   - char: baseColor, charColor, toneStart, toneEnd, toneGamma, rampOnsetK.
   - melt: baseColor, frostColor, frostStart, frostFull, rampOnsetK.
   - bleach: baseColor, markColor, markStart, markFull.
   - depth (char, melt): from 2–3 manual readings, mean depth over the cell =
     k · mean(max(0, dose − threshold)); threshold scanned, k closed form.
   - fire (temperature kind): from the cells the user saw flame, the
     threshold between the hottest calm and the coolest flaming cell's bulk
     temperature, reported as an interval.
   - optional S → power curve: one factor per power step, relative to an
     anchor step (S max when it has at least two cells on the ramp).
7. **Review and save.** Per-cell ΔE00 fitted vs photographed; the fitted
   profile has the same schema with `provenance.source = 'calibrated'`,
   `fittedAt` and `meanDeltaE`.

No schema change: every fitted value is an existing `MaterialProfile` field.

## What the fit does not do

- **Absorption, σ_heat and the thermal constants are not fitted.** Absorbed
  energy scales every threshold together, so absorption and the thresholds
  can't be told apart from colour. Thresholds are therefore "absorbed dose for
  this material at the starting absorption".
- **Power and sensitivity trade off.** Without a power-curve fit the module's
  nominal curve is assumed. With it, the curve's shape is fitted relative to
  the anchor step. When the S max column is entirely past full mark (or
  unmarked) the absolute scale moves to another step whose nominal power is
  assumed right; generate the grid with faster rows to keep S max on the ramp.
- **melt's rampOnsetK is barely constrained by the default grid** on dark
  acrylic: the bulk term is small there, so the colours hardly depend on it
  (σ ≈ 160 K on a 300 K rise). It is fitted, reported with its σ, and matters
  correspondingly little for prediction.
- **Bleach damage threshold, absorption feedback level** are kept.
- **Printed card accuracy**: patch references are the nominal colours of the
  printed sRGB values. A measured card (colorimeter) can be passed in.
- **Camera**: assumes sRGB encoding and that an affine map in linear light
  covers white balance, exposure and the camera's colour matrix. Vignetting is
  not modelled (only a planar gradient).
- **Scan offset (BURN-48)** is applied by the forward model through the
  machine profile; the 20 % inset keeps reverse-line ends out of the sample for
  offsets up to 1.2 mm on a 6 mm cell. An offset that is real but missing from
  the profile shifts cell edges only, outside the sample.
- **GPU vs CPU and tile plans**: the forward model is the CPU reference at a
  fixed 10 µm pitch. The app's GPU sim at its job pitch can differ slightly
  (BURN-37: edge cells), so tests use tolerances, never equality.

## Round-trip verification

`src/testing/calibration-roundtrip*.ts`: the truth is rendered by the same
simulator at 25 µm (the fit runs at 10 µm), composited with the card on a
textured board and photographed with perspective, rotation, uneven light,
vignetting, white balance, exposure, blur, noise and 8-bit encoding (three
condition sets, one with clipping, one with a 1 ΔE card print error). Results
and tolerances: `docs/bench/burn-15-roundtrip-macos-m1.md`.

Real accuracy (ΔE on held-out real burns) is BURN-12's.

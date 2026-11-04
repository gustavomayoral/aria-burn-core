# Provisional profiles: sources and derivation (COD-266)

> **PROVISIONAL — not validated against real burns.** Every number in this folder comes from published settings, vendor specs or handbook data. No laser was used to make them. COD-254 compares them with real burns and replaces them. This changes parameters, not code.

Files:

| File | Schema | What it is |
|---|---|---|
| `machine-10w-diode.json` | `MachineProfile` | Default machine: a generic 10 W optical diode in the Sculpfun S30 Pro class |
| `birch-ply.json` | `MaterialProfile` (`char`) | Birch or basswood plywood |
| `black-cast-acrylic.json` | `MaterialProfile` (`melt`) | Black cast PMMA |
| `black-anodized-aluminum.json` | `MaterialProfile` (`bleach`) | Black type II anodized aluminum |

The raw settings rows are also kept as data in `derivation.ts`. `src/profiles/profiles.test.ts` validates these files against the TypeBox schema, the exported JSON Schema and the ordering checks. It also recomputes the fluence tables below from the raw settings, so if one is edited the other has to be edited too.

## 1. Machine profile

| Field | Value | Source / reasoning | Confidence |
|---|---|---|---|
| `opticalPowerW` | 10 | Sculpfun S30 Pro product page: "10W … light energy not electrical" ([sculpfun.com](https://sculpfun.com/products/sculpfun-s30-pro-laser-engraving-machine-10w)). This is the vendor's claim, not a measurement. | Low–medium |
| `spot` minor 1/e² diameter | 0.06 mm → `sigmaYMm` 0.015 | Vendor spec 0.06 × 0.08 mm (Sculpfun S30 Pro blog/listings; xTool D1 Pro 10W lists 0.08 × 0.06). Forum estimates of the minor axis agree: 0.05 mm on a 10 W Ortur, 0.06 mm on another 10 W head. | Medium |
| `spot` major 1/e² diameter | 0.12 mm → `sigmaXMm` 0.03 | The vendor spec says 0.08. Independent forum reports put the long axis at 0.10–0.14 mm on 10 W heads ("60 micron by 140 micron", ".05 x .10"), and an experienced user calls 0.10–0.12 realistic for 20 W ([LightBurn: ACMER oversized spot](https://forum.lightburnsoftware.com/t/acmer-20w-module-oversized-laser-spot-along-y-axis-0-2-mm-instead-of-0-08-mm-support-unhelpful-anyone-else-had-this/173062)). I used a middle value of 0.12. | Low |
| `spot.angleDeg` | 90 (long axis along machine Y) | In the ACMER report, lines drawn along X come out wide, so the long axis runs along Y. This varies with how the module is mounted. | Low |
| σ convention | σ = d / 4 | Vendor "spot size" is read as the 1/e² diameter. If vendors actually quote FWHM, σ would be d / 2.355, about 1.7× larger. | — |
| `powerCurve` | (0,0) (0.05,0) (0.10,0.04) (0.20,0.14) (1,1) | Nichia NUBM-class 450 nm diodes: threshold 150–350 mA at about 3 A operating current ([NUBM44 listing](https://optlasersgrav.com/laser-diodes/nubm44-445nm-6w)), and a datasheet for a related NUBM part gives threshold 240–440 mA with slope about 2 W/A ([Nichia datasheet via TI E2E](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/94/4_5F00_UTZ_2D00_SC0730_5F00_0_5F00_NUBM0FE-_2D002D00_455.pdf)). Threshold is therefore about 5–12 % of operating current. The curve is a dead zone up to 5 % S, a soft knee to 20 %, then linear. It assumes the driver maps S to current linearly (constant-current PWM averaging). | Low |
| `sMax` | 1000 | `$30=1000` is the usual value on GRBL diode machines and LightBurn's default | Medium |
| `laserMode` | true | `$32=1` is required for diode lasers on GRBL | High |
| `junctionDeviationMm` | 0.01 | GRBL 1.1 default `$11` | Medium |
| `maxRateMmPerMin` | 10000 | Common figure for S30-class machines; **not confirmed** on the vendor page | Low |
| `accelMmPerS2` | 1000 | Middle of the 250–2500 range reported for GRBL diode machines ([GRBL tuning guides](https://docs.sainsmart.com/article/9m0rbnw6k1-introduction-to-cnc-for-a-total-novice-tuning-gbrl-settings), [LightBurn forum](https://forum.lightburnsoftware.com/t/acceleration-problem/22258)); no factory `$120` value was found | Low |
| `travelMm` | 410 × 400 | Sculpfun S30 Pro work area (the same page also says 380 × 385 elsewhere) | Medium |

**Grid pitch (COD-260 open point).** `gridPitchMm` = minor σ ÷ 3 = 0.005 mm. At the `TILE_MAX_CELLS` = 9000 hard cap that gives **45 mm per tile**, which is smaller than the about 60 mm the COD-260 placeholder gave. Since BURN-36 the actual tile side comes from the GPU byte budget and is often smaller (e.g. ~34 mm at 6720 cells on an M1 for a 100 mm job). The blur kernel adds heat spread in quadrature (wood: √(0.015² + 0.013²) ≈ 0.020 mm), but the pitch rule uses only the spot. See "Known uncertainty" item 1.

## 2. Fluence derivation

The simulator deposits **absorbed** energy (`deposit.ts`: E = powerW · dtS · absorption). For that reason every material threshold below is **absorbed** fluence:

```
F_abs = absorption × P_W × powerCurve(S) / (v_mm/s × lineInterval_mm)     [J/mm²]
```

- `P_W` is the source machine's rated optical power, mapped through **this profile's** power curve. A user who types the same S into the simulator then gets the same fluence the source machine delivered.
- If a source gives no line interval, it is assumed to be 0.1 mm (100 lines/cm), the most common default. These rows are marked "LI assumed".
- 20 W rows are kept because they widen the spread, but they come from machines with a larger spot.

Turning the spread into thresholds (the same rule for all three materials):

| Threshold | Rule |
|---|---|
| Start (under-burn below) | min(good settings) ÷ 1.5 |
| Mid-band / full | median(good settings) |
| Over-burn / removal / damage | max(good settings) × 1.3 |

### 2a. Birch / basswood plywood (`char`), absorption 0.6

| Source | Raw setting | F_abs (J/mm²) |
|---|---|---|
| [lasergenerator xTool chart](https://lasergenerator.com/laser-settings/xtool/), D1/D1 Pro/S1 10 W, basswood ply | 40 % · 100 mm/s · 100 lines/cm | 0.213 |
| same, birch ply | 45 % · 100 mm/s · 100 lines/cm | 0.245 |
| [Koenig / xTool AU settings](https://xtool.koenigmachinery.com.au/pages/material-settings), D1 Pro 10 W, birch ply raster | 80 % · 100 mm/s · 1 pass (LI assumed) | 0.471 |
| [hobbyistlasercalc D1 Pro](https://hobbyistlasercalc.com/xtool-d1-pro-settings-guide), 10 W, basswood | 40 % · 3000 mm/min (LI assumed) | 0.426 |
| Koenig, M1 10 W, basswood bitmap | 70 % · 175 mm/s (LI assumed) | 0.232 |
| [bonnycreations D1 Pro 20 W](https://www.bonnycreations.com/settings/machines/xtool-d1-pro), Official, basswood | 40 % · 100 mm/s (LI assumed) | 0.426 |
| same, Community, basswood | 55 % · 3000 mm/min · 0.1 mm | 1.239 |
| same, Community, basswood | 70 % · 4000 mm/min · 0.1 mm | 1.219 |
| same, Community, 9 mm birch | 70 % · 3500 mm/min (LI assumed) | 1.394 |
| **Spread / median** | | **0.213 – 1.394 / 0.426** |

| Field | Value | Reasoning |
|---|---|---|
| `toneStartJPerMm2` | 0.14 | 0.213 ÷ 1.5 |
| `toneEndJPerMm2` | 1.8 | 1.394 × 1.3 |
| `toneGamma` | 0.4 | Places the median "good engrave" (0.426) at half tone, assuming tone = t^γ with t = (F − start)/(end − start) |
| `ablationThresholdJPerMm2` | 0.43 | The median: typical engraves leave a shallow recess |
| `depthMmPerJPerMm2` | 0.17 | Cut settings for 3 mm basswood ply at 10 W, 100 %, 3–6 mm/s, 2 passes (lasergenerator, Koenig), with an assumed 0.15 mm kerf → about 9.9 J/mm³ incident, or 5.9 J/mm³ absorbed |
| `absorption` | 0.6 | Silver birch L\* ≈ 81 and b\* ≈ 20 (yellow) imply a blue reflectance of about 0.40 at 450 nm. Charring raises this; v1 has no char feedback. |
| `sigmaHeatMm` | 0.013 | √(2ατ), with α = 0.147 mm²/s (below) and τ = 0.06 mm ÷ 100 mm/s dwell |
| `baseColor` | L 81, a 7, b 20 | Planed, dried silver birch, L\* 81.1 a\* 7.2 b\* 20.0 ([Acta Facultatis Xylologiae 65/1, 2023](https://issuu.com/www.tuzvo.sk/docs/afxz_65_1_2023/s/27375643)) |
| `charColor` | L 28, a 6, b 10 | **Rough guide only**: read from published test-grid photos under uncontrolled lighting. CO₂-laser CIELab studies on beech, maple and lime ([Kubovský 2018](https://bioresources.cnr.ncsu.edu/wp-content/uploads/2018/02/BioRes_13_2_2515_Kubovsky_KV_Effects_CO2-Laser_Color_Chemical_Components_Hardwood_13378.pdf), [Gurau 2017](https://bioresources.cnr.ncsu.edu/wp-content/uploads/2017/08/BioRes_12_4_7395_Gurau_PVT_Infl_CO2_Laser_Beam_Power_Surf_Roughness_Color_Beech_12211.pdf)) confirm that L\* falls steadily with dose, but no 450 nm study was found. |
| `fireRisk` | fluence 12 | Below the single-line cut dose (10 W ÷ (4.5 mm/s × 0.08 mm) × 0.6 ≈ 17 absorbed). Flaming is common when cutting without air assist. |

### 2b. Black cast acrylic (`melt`), absorption 0.92

| Source | Raw setting | F_abs (J/mm²) |
|---|---|---|
| lasergenerator, 10 W, cast acrylic black/opaque | 30 % · 150 mm/s · 100 lines/cm | 0.152 |
| hobbyistlasercalc, 10 W, cast acrylic (colour not stated) | 30 % · 4000 mm/min (LI assumed) | 0.342 |
| Koenig, D1 Pro 10 W, dark red opaque glossy, raster | 80 % · 50 mm/s (LI assumed) | 1.444 |
| Koenig, M1 10 W, brown opaque glossy, fill | 35 % · 130 mm/s (LI assumed) | 0.213 |
| Koenig, M1 10 W, dark red opaque glossy, bitmap | 30 % · 100 mm/s (LI assumed) | 0.228 |
| bonnycreations 20 W, Community, black acrylic | 50 % · 4000 mm/min (LI assumed) | 1.276 |
| *Excluded:* bonnycreations 20 W Official "Black Acrylic (Transparent, Glossy)" | 100 % · 50 mm/s | transparent, so 450 nm passes through |
| **Spread / median** | | **0.152 – 1.444 / 0.285** |

| Field | Value | Reasoning |
|---|---|---|
| `frostStartJPerMm2` | 0.10 | 0.152 ÷ 1.5 |
| `frostFullJPerMm2` | 0.29 | median |
| `removalThresholdJPerMm2` | 1.9 | 1.444 × 1.3. Because melt "over" = removal threshold (COD-260 open point), this also marks the over-burn verdict. |
| `depthMmPerJPerMm2` | 0.3 | Ablating PMMA takes about 1.6 J/mm³ (ρc·ΔT to about 370 °C ≈ 0.6 J/mm³, plus depolymerisation ≈ 56 kJ/mol ≈ 0.67 J/mm³, plus margin), which gives about 0.6 mm per J/mm² as the upper bound. Halved for melt-pool and conduction losses. |
| `absorption` | 0.92 | About 4 % Fresnel reflection off a glossy surface; black pigment absorbs the rest near the surface |
| `sigmaHeatMm` | 0.011 | √(2ατ), with α = 0.109 mm²/s |
| `baseColor` / `frostColor` | L 8 / L 50 | Rough guide from vendor and blog photos ("expect frosted grey marks rather than white", [Blazex](https://ca.blazexlaser.com/blogs/news/diode-laser-engraver-how-to-engrave-black-acrylic-without-burning-or-melting)) |
| `fireRisk` | fluence 25 | PMMA burns. Set well below the cut dose for 3 mm (about 60 incident). |

### 2c. Black anodized aluminum (`bleach`), absorption 0.88

| Source | Raw setting | F_abs (J/mm²) |
|---|---|---|
| lasergenerator, 10 W, anodized aluminium | 80 % · 60 mm/s · 100 lines/cm | 1.151 |
| [LightBurn forum, 10 W (MikeyH)](https://forum.lightburnsoftware.com/t/engraving-anodized-aluminum-on-ortur-laser-master-2-10w/180302), "used on 2 different 10w machines" | 30 % · 2500 mm/min · 318 LPI | 0.654 |
| bonnycreations 20 W, Community | 70–80 % · 1500 mm/min (LI assumed) | 5.148 |
| same | 60–75 % · 2000 mm/min (LI assumed) | 3.436 |
| same | 50 % · 1500 mm/min (LI assumed) | 3.256 |
| same, citing the xTool EasySet library | 100 % · 4000 mm/min · 0.1 mm | 2.640 |
| **Spread / median** | | **0.654 – 5.148 / 2.948** |

| Field | Value | Reasoning |
|---|---|---|
| `markStartJPerMm2` | 0.44 | 0.654 ÷ 1.5 |
| `markFullJPerMm2` | 2.95 | median |
| `damageThresholdJPerMm2` | 6.7 | 5.148 × 1.3 |
| `absorption` | 0.88 | Black dye with L\* ≈ 20 reflects only a few percent; matte surface |
| `sigmaHeatMm` | 0.02 | √(2ατ) in the porous oxide, α ≈ 0.27 mm²/s (k ≈ 0.7 W/m·K). The aluminium substrate pulls heat downward, which keeps marks sharp. |
| `baseColor` / `markColor` | L 20 / L 82 | Rough guide from test-grid photos |
| `fireRisk` | none | Metal substrate |

## 3. Thermal constants (COD-258)

Wood and acrylic use the `peakTemperature` thermal model (`src/contract/thermal.ts`) with the values below (contract units: W/(mm·K), J/(mm³·K), K). Anodized aluminium stays `none`: its heat path is a thin oxide on an aluminium heat sink, which one conductivity can't describe, and it builds up little heat. Its response stays fluence-driven.

| Material | k (W/m·K) | ρ (kg/m³) | c (J/kg·K) | → `conductivityWPerMmK` | → `volumetricHeatCapacityJPerMm3K` | α (mm²/s) | Source |
|---|---|---|---|---|---|---|---|
| Birch ply, 12 % MC | 0.16 | 680 | 1600 | 1.6e-4 | 1.09e-3 | 0.147 | Wood Handbook (FPL-GTR-190/282 ch. 4): k = G(B + C·M) + A with G ≈ 0.6, M = 12; c₀ ≈ 1.26 kJ/kg·K dry, rising to about 1.6 at 12 % MC. Ply density varies 600–720. |
| PMMA (cast) | 0.19 | 1190 | 1470 (1260–1470) | 1.9e-4 | 1.75e-3 | 0.109 | [NETZSCH PMMA](https://analyzing-testing.netzsch.com/en/polymers-netzsch-com/engineering-thermoplastics/pmma-polymethylmethacrylate) (c 1.45–1.47 J/g·K), [MakeItFrom](https://www.makeitfrom.com/material-properties/Polymethylmethacrylate-PMMA-Acrylic) (k 0.19, c 1.26) |
| Al 6061 substrate | 167 | 2700 | 896 | 0.167 | 2.42e-3 | 69 | Standard handbook values (ASM); not fetched in this pass |
| Anodic oxide, type II | 0.5–1.0 | ≈ 3000 | ≈ 880 | 7e-4 | ≈ 2.6e-3 | ≈ 0.27 | Porous sulfuric-acid anodic alumina, 15–80 µm ([Nanoscale Adv. 2020 review](https://pubs.rsc.org/en/content/articlehtml/2020/na/d0na00578a)) |

`ambientK` = 293.

| Event temperature | Value | Source |
|---|---|---|
| Wood char onset (hemicellulose pyrolysis) | 200–300 °C, use 250 °C (523 K) | Kubovský 2018 (ΔL\* tracks hemicellulose loss), COD-266 brief |
| Wood ignition: glowing at minimum flux | ≈ 250 °C | Babrauskas, "Ignition of Wood: A Review of the State of the Art", J. Fire Prot. Eng. 2002 |
| Wood ignition: piloted flaming | 300–365 °C → `fireRisk.thresholdK` ≈ 573 K | same |
| PMMA glass transition | 105 °C (atactic) – 110 °C | NETZSCH, MakeItFrom |
| PMMA decomposition | 360–390 °C | NETZSCH |

### 3a. Thermal-model fields

| Field | Birch ply | Black cast acrylic | Reasoning |
|---|---|---|---|
| `conductivityWPerMmK` | 1.6e-4 | 1.9e-4 | Table above |
| `volumetricHeatCapacityJPerMm3K` | 1.09e-3 | 1.75e-3 | ρ·c, table above |
| `ambientK` | 293 | 293 | Room temperature |
| `rampOnsetK` | 523 | 633 | Peak surface temperature where the ramp starts (toneStart / frostStart) on a cold pass at the reference speed. Wood: char onset, 250 °C. Acrylic: decomposition onset, 360 °C (frosting is surface foaming from monomer release). It only sets the flash term's scale: `(rampOnsetK − ambient) ÷ rampStart` K per J/mm². Real flashes are limited by pyrolysis and ablation, so this is a calibration point, not a measured flash temperature. |
| `referenceSpeedMmPerS` | 100 | 83 | Median speed of the published settings rows in §2 (wood: 100; acrylic: the mean of the middle two, 66.7 and 100). At this speed along X, dose = fluence for a cold pass, so the fluence thresholds keep their meaning. |
| `absorptionAtFullChar` | 0.9 | — | Char at L\* ≈ 28 reflects about 5–10 % in the blue (same reasoning as `absorption`). Char only. |
| `fireRisk.thresholdK` | 873 | 733 | Compared with the **bulk** temperature (heat older than 20 ms at thermal-grid scale), not the flash. Wood: about 600 °C, the high end of surface temperatures at ignition under high heat flux (Babrauskas 2002 reports 250–365 °C for long, low-flux exposures and higher values as flux rises; not re-checked in this pass). With 573 K (300 °C), normal small engraving fills already flag, because the linear model has no pyrolysis sink. Acrylic: PMMA autoignition, about 450–460 °C (commonly cited; not re-checked in this pass). |

**Effect on the fluence thresholds.** At the reference speed and on cold material, dose equals fluence. Fills preheat themselves, so a typical published fill setting now reads about 1.3–2× its fluence as dose (wood, 100 mm/s, 0.1 mm interval, small fills). Slower settings read lower (√v for fast passes). The §2 thresholds were fitted as fluence, so COD-254 should refit them as dose: the thermal model changes what the thresholds mean, not the code.

## 4. Known uncertainty: what COD-254 should check first

1. **Spot size and its effect on grid pitch** (most likely wrong, and the most consequential). The long axis (0.12 mm) is a midpoint between the vendor spec and forum estimates. The short axis sets the grid pitch (0.005 mm) and so a tile size of 45 mm. Measure it with LightBurn's interval test on anodized aluminium (forum method) before tuning anything else. Separately, it may be worth deriving the pitch from the full kernel σ (spot ⊕ heat) instead of the spot alone. That is a COD-264 decision, not a parameter change.
2. **Optical power.** "10 W" is the vendor's claim. Real modules are often measured below their rating. Every absorbed-fluence threshold scales with it, but the burn predictions do not: thresholds were derived through the same nominal power, so the error cancels for this machine, but not when comparing across machines.
3. **Anodized aluminium thresholds.** The two 10 W sources (0.65, 1.15) sit far below the 20 W community cluster (2.6–5.1). With `markFull` at the median of 2.95, the 10 W settings would render as partial marks. Real bleaching is close to on/off, so `markFull` is probably too high for this machine.
4. **Missing line intervals.** 13 of 21 rows assume 0.1 mm. If a source used 0.08 mm, its fluence is 25 % higher.
5. **Acrylic removal and over-burn.** Black acrylic always loses a little material when frosted. Setting the removal threshold at max × 1.3 means the depth map stays at zero for typical engraves.
6. **Colours.** Only birch `baseColor` comes from a CIELab measurement. Char, frost and mark colours are read from photos.
7. **Power curve.** The dead zone and knee are generic. Measure optical power at S = 5, 10, 20, 50 and 100 % with a power meter.
8. **Wood absorption 0.6** is inferred from colour, not measured. It scales all wood thresholds together. With char feedback (COD-258) the ratio to `absorptionAtFullChar` now matters too.
9. **Thermal model (COD-258).** Check these, in order:
   - whether equal-fluence pairs differ as much as the √v flash factor predicts;
   - the fire thresholds against real flame-ups (small dense fills, slow vector lines);
   - `rampOnsetK`, which only sets a scale and could equally be fitted as a number of K per J/mm².

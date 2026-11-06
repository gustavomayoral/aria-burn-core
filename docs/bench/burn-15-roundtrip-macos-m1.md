# BURN-15 photo-fit round trip

Generated 2026-11-06T01:33:36.213Z on darwin/arm64, Node v26.13.0.
Truth: each provisional profile moved away from its starting values (calibration-roundtrip.ts `trueMaterial`); the fit starts from the provisional profile.
Grid: the default power × speed grid (7 × 6 cells) for the provisional 10 W diode. Render at 25 µm, fit at 10 µm. Thermal step: CPU reference on a 0.5 mm grid with 2 s bins, for truth and fit alike.
Depths: three gauge readings (most burned cell, a quarter and half way down the depth ranking) with −0.005, 0 and +0.005 mm error. Fire: the cells whose true bulk temperature reaches the true threshold are flagged.

Conditions:
- **mild**: {"seed":11,"rotationDeg":3,"perspective":0.02,"whiteBalance":[1.05,1,0.95],"exposure":1,"gradient":{"strength":0.05,"angleDeg":20},"vignette":0.02,"blurPx":0.8,"noise":{"read":0.001,"shot":0.005}}
- **harsh**: {"seed":23,"rotationDeg":97,"perspective":0.06,"cardSide":"below","cardAngleDeg":12,"whiteBalance":[1.3,1,0.7],"exposure":0.6,"gradient":{"strength":0.15,"angleDeg":120},"vignette":0.08,"blurPx":1.6,"noise":{"read":0.004,"shot":0.02},"texture":0.03,"cardPrintErrorDE":1}
- **upsideDown**: {"seed":37,"rotationDeg":183,"perspective":0.04,"cardSide":"left","cardAngleDeg":-7,"whiteBalance":[0.85,1,1.2],"exposure":1.3,"gradient":{"strength":0.1,"angleDeg":250},"vignette":0.05,"blurPx":1.2,"noise":{"read":0.002,"shot":0.012}}

## Birch / basswood plywood (provisional) — char

Depth entries: r6c7 0.298 mm, r3c6 0.119 mm, r3c4 0.046 mm.
Flamed cells: r4c7, r5c6, r5c7, r6c6, r6c7.
Truth setup 8.3 s.

### mild photo

Mean ΔE00 fitted vs photographed 0.13 (max 0.32, limit 1); card patches after correction 0.10; thermal runs 3; 34.0 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 77.000 | 77.260 | +0.26 | ±1.5 | yes |
| baseColor.a | 8.500 | 8.511 | +0.01 | ±1.5 | yes |
| baseColor.b | 23.000 | 23.080 | +0.08 | ±1.5 | yes |
| charColor.l | 24.000 | 24.080 | +0.08 | ±1.5 | yes |
| charColor.a | 7.000 | 6.975 | -0.03 | ±1.5 | yes |
| charColor.b | 9.000 | 8.892 | -0.11 | ±1.5 | yes |
| toneStartJPerMm2 | 0.1820 | 0.1815 | -0.3 % | ±6 % | yes |
| toneEndJPerMm2 | 1.440 | 1.423 | -1.2 % | ±4 % | yes |
| toneGamma | 0.5500 | 0.5452 | -0.9 % | ±3 % | yes |
| rampOnsetK | 560.0 | 578.8 | +3.4 % | ±12 % | yes |
| ablationThresholdJPerMm2 | 0.6000 | 0.5429 | -9.5 % | ±15 % | yes |
| depthMmPerJPerMm2 | 0.1200 | 0.1168 | -2.7 % | ±5 % | yes |
| fireRisk.thresholdK | 780.0 | 772.0 | -8 K | in [754, 790] K | yes |

rampOnsetK − ambient fitted σ: 41 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

### harsh photo

Mean ΔE00 fitted vs photographed 0.41 (max 1.05, limit 1); card patches after correction 1.11; thermal runs 3; 34.7 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 77.000 | 76.890 | -0.11 | ±1.5 | yes |
| baseColor.a | 8.500 | 8.523 | +0.02 | ±1.5 | yes |
| baseColor.b | 23.000 | 23.320 | +0.32 | ±1.5 | yes |
| charColor.l | 24.000 | 24.090 | +0.09 | ±1.5 | yes |
| charColor.a | 7.000 | 7.033 | +0.03 | ±1.5 | yes |
| charColor.b | 9.000 | 9.104 | +0.10 | ±1.5 | yes |
| toneStartJPerMm2 | 0.1820 | 0.1823 | +0.2 % | ±6 % | yes |
| toneEndJPerMm2 | 1.440 | 1.430 | -0.7 % | ±4 % | yes |
| toneGamma | 0.5500 | 0.5467 | -0.6 % | ±3 % | yes |
| rampOnsetK | 560.0 | 576.6 | +3.0 % | ±12 % | yes |
| ablationThresholdJPerMm2 | 0.6000 | 0.5430 | -9.5 % | ±15 % | yes |
| depthMmPerJPerMm2 | 0.1200 | 0.1167 | -2.7 % | ±5 % | yes |
| fireRisk.thresholdK | 780.0 | 772.0 | -8 K | in [753, 790] K | yes |

rampOnsetK − ambient fitted σ: 40 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

### upsideDown photo

Mean ΔE00 fitted vs photographed 0.19 (max 0.46, limit 1); card patches after correction 0.33; thermal runs 3; 32.4 s.
Warnings: 3 card patch(es) clipped or unreadable and left out: the photo may be overexposed. The card’s white border is clipped: lighting estimated from the bare material only.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 77.000 | 77.650 | +0.65 | ±1.5 | yes |
| baseColor.a | 8.500 | 8.550 | +0.05 | ±1.5 | yes |
| baseColor.b | 23.000 | 23.130 | +0.13 | ±1.5 | yes |
| charColor.l | 24.000 | 24.010 | +0.01 | ±1.5 | yes |
| charColor.a | 7.000 | 7.173 | +0.17 | ±1.5 | yes |
| charColor.b | 9.000 | 9.118 | +0.12 | ±1.5 | yes |
| toneStartJPerMm2 | 0.1820 | 0.1750 | -3.8 % | ±6 % | yes |
| toneEndJPerMm2 | 1.440 | 1.403 | -2.6 % | ±4 % | yes |
| toneGamma | 0.5500 | 0.5527 | +0.5 % | ±3 % | yes |
| rampOnsetK | 560.0 | 598.3 | +6.8 % | ±12 % | yes |
| ablationThresholdJPerMm2 | 0.6000 | 0.5340 | -11.0 % | ±15 % | yes |
| depthMmPerJPerMm2 | 0.1200 | 0.1190 | -0.8 % | ±5 % | yes |
| fireRisk.thresholdK | 780.0 | 771.0 | -9 K | in [753, 790] K | yes |

rampOnsetK − ambient fitted σ: 46 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

## Black cast acrylic (provisional) — melt

Depth entries: r6c7 0.343 mm, r5c5 0.094 mm, r1c4 0.005 mm.
Flamed cells: r5c7, r6c6, r6c7.
Truth setup 7.0 s.

### mild photo

Mean ΔE00 fitted vs photographed 0.18 (max 1.16, limit 1); card patches after correction 0.13; thermal runs 1; 15.7 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 9.000 | 9.390 | +0.39 | ±1.5 | yes |
| baseColor.a | 0.5000 | 0.3374 | -0.16 | ±1.5 | yes |
| baseColor.b | -0.5000 | -0.3844 | +0.12 | ±1.5 | yes |
| frostColor.l | 55.000 | 55.140 | +0.14 | ±1.5 | yes |
| frostColor.a | 0.0000 | -0.0130 | -0.01 | ±1.5 | yes |
| frostColor.b | -2.000 | -2.056 | -0.06 | ±1.5 | yes |
| frostStartJPerMm2 | 0.1400 | 0.1393 | -0.5 % | ±4 % | yes |
| frostFullJPerMm2 | 0.3625 | 0.3560 | -1.8 % | ±4 % | yes |
| removalThresholdJPerMm2 | 1.400 | 1.376 | -1.7 % | ±4 % | yes |
| depthMmPerJPerMm2 | 0.2500 | 0.2476 | -1.0 % | ±4 % | yes |
| rampOnsetK | 600.0 | 636.8 | +36.8 | ≤ 2 σ (σ = 168) | yes |
| fireRisk.thresholdK | 733.0 | 709.0 | -24 K | in [681, 737] K | yes |

rampOnsetK − ambient fitted σ: 168 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

### harsh photo

Mean ΔE00 fitted vs photographed 0.60 (max 2.09, limit 1); card patches after correction 1.12; thermal runs 1; 10.4 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 9.000 | 9.154 | +0.15 | ±1.5 | yes |
| baseColor.a | 0.5000 | 1.454 | +0.95 | ±1.5 | yes |
| baseColor.b | -0.5000 | -1.391 | -0.89 | ±1.5 | yes |
| frostColor.l | 55.000 | 54.180 | -0.82 | ±1.5 | yes |
| frostColor.a | 0.0000 | 0.1188 | +0.12 | ±1.5 | yes |
| frostColor.b | -2.000 | -2.022 | -0.02 | ±1.5 | yes |
| frostStartJPerMm2 | 0.1400 | 0.1427 | +1.9 % | ±4 % | yes |
| frostFullJPerMm2 | 0.3625 | 0.3565 | -1.7 % | ±4 % | yes |
| removalThresholdJPerMm2 | 1.400 | 1.385 | -1.1 % | ±4 % | yes |
| depthMmPerJPerMm2 | 0.2500 | 0.2460 | -1.6 % | ±4 % | yes |
| rampOnsetK | 600.0 | 622.3 | +22.3 | ≤ 2 σ (σ = 161) | yes |
| fireRisk.thresholdK | 733.0 | 709.0 | -24 K | in [681, 737] K | yes |

rampOnsetK − ambient fitted σ: 161 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

### upsideDown photo

Mean ΔE00 fitted vs photographed 0.26 (max 0.98, limit 1); card patches after correction 0.31; thermal runs 1; 9.4 s.
Warnings: 3 card patch(es) clipped or unreadable and left out: the photo may be overexposed. The card’s white border is clipped: lighting estimated from the bare material only.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 9.000 | 8.384 | -0.62 | ±1.5 | yes |
| baseColor.a | 0.5000 | 1.129 | +0.63 | ±1.5 | yes |
| baseColor.b | -0.5000 | -0.3864 | +0.11 | ±1.5 | yes |
| frostColor.l | 55.000 | 55.580 | +0.58 | ±1.5 | yes |
| frostColor.a | 0.0000 | 0.0758 | +0.08 | ±1.5 | yes |
| frostColor.b | -2.000 | -1.957 | +0.04 | ±1.5 | yes |
| frostStartJPerMm2 | 0.1400 | 0.1396 | -0.3 % | ±4 % | yes |
| frostFullJPerMm2 | 0.3625 | 0.3573 | -1.4 % | ±4 % | yes |
| removalThresholdJPerMm2 | 1.400 | 1.384 | -1.1 % | ±4 % | yes |
| depthMmPerJPerMm2 | 0.2500 | 0.2461 | -1.6 % | ±4 % | yes |
| rampOnsetK | 600.0 | 616.0 | +16.0 | ≤ 2 σ (σ = 158) | yes |
| fireRisk.thresholdK | 733.0 | 709.0 | -24 K | in [681, 737] K | yes |

rampOnsetK − ambient fitted σ: 158 K.
Fire: Between the hottest calm cell and the coolest cell that flamed.
Depth: Fitted from 3 cells with depth.

## Black anodized aluminum (provisional) — bleach

Truth setup 1.2 s.

### mild photo

Mean ΔE00 fitted vs photographed 0.14 (max 0.39, limit 1); card patches after correction 0.15; thermal runs 1; 10.1 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 24.000 | 24.230 | +0.23 | ±1.5 | yes |
| baseColor.a | 0.5000 | 0.4281 | -0.07 | ±1.5 | yes |
| baseColor.b | -1.000 | -1.059 | -0.06 | ±1.5 | yes |
| markColor.l | 75.000 | 75.130 | +0.13 | ±1.5 | yes |
| markColor.a | 1.000 | 1.007 | +0.01 | ±1.5 | yes |
| markColor.b | 4.000 | 3.979 | -0.02 | ±1.5 | yes |
| markStartJPerMm2 | 0.5720 | 0.5729 | +0.2 % | ±3 % | yes |
| markFullJPerMm2 | 2.360 | 2.354 | -0.3 % | ±2 % | yes |

### harsh photo

Mean ΔE00 fitted vs photographed 0.47 (max 0.90, limit 1); card patches after correction 1.15; thermal runs 1; 9.8 s.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 24.000 | 23.780 | -0.22 | ±1.5 | yes |
| baseColor.a | 0.5000 | 1.047 | +0.55 | ±1.5 | yes |
| baseColor.b | -1.000 | -1.159 | -0.16 | ±1.5 | yes |
| markColor.l | 75.000 | 74.790 | -0.21 | ±1.5 | yes |
| markColor.a | 1.000 | 1.127 | +0.13 | ±1.5 | yes |
| markColor.b | 4.000 | 4.173 | +0.17 | ±1.5 | yes |
| markStartJPerMm2 | 0.5720 | 0.5712 | -0.1 % | ±3 % | yes |
| markFullJPerMm2 | 2.360 | 2.365 | +0.2 % | ±2 % | yes |

### upsideDown photo

Mean ΔE00 fitted vs photographed 0.21 (max 0.52, limit 1); card patches after correction 0.30; thermal runs 1; 8.7 s.
Warnings: 3 card patch(es) clipped or unreadable and left out: the photo may be overexposed. The card’s white border is clipped: lighting estimated from the bare material only.

| field | true | fitted | error | tolerance | pass |
|---|---:|---:|---:|---|---|
| baseColor.l | 24.000 | 23.970 | -0.03 | ±1.5 | yes |
| baseColor.a | 0.5000 | 0.5713 | +0.07 | ±1.5 | yes |
| baseColor.b | -1.000 | -0.9227 | +0.08 | ±1.5 | yes |
| markColor.l | 75.000 | 75.640 | +0.64 | ±1.5 | yes |
| markColor.a | 1.000 | 0.9674 | -0.03 | ±1.5 | yes |
| markColor.b | 4.000 | 4.126 | +0.13 | ±1.5 | yes |
| markStartJPerMm2 | 0.5720 | 0.5755 | +0.6 % | ±3 % | yes |
| markFullJPerMm2 | 2.360 | 2.355 | -0.2 % | ±2 % | yes |

## S → power curve, aluminium, fast rows (S max on the ramp), mild photo

| S | nominal | true | fitted factor | true factor | error | constrained |
|---:|---:|---:|---:|---:|---:|---|
| 15 % | 0.090 | 0.060 | 1.0000 | 0.6667 | 50.0 % | no |
| 29 % | 0.237 | 0.205 | 0.8722 | 0.8659 | 0.7 % | no |
| 43 % | 0.387 | 0.368 | 0.9546 | 0.9512 | 0.4 % | yes |
| 58 % | 0.548 | 0.538 | 0.9864 | 0.9809 | 0.6 % | yes |
| 72 % | 0.699 | 0.692 | 0.9941 | 0.9900 | 0.4 % | yes |
| 86 % | 0.849 | 0.846 | 0.9975 | 0.9959 | 0.2 % | yes |
| 100 % | 1.000 | 1.000 | 1.0000 (anchor) | 1.0000 | 0.0 % | yes |

markStart 0.5773 (true 0.572), markFull 2.377 (true 2.36). S → power: factors are relative to S 100.0 %, whose nominal power is taken as right. Steps with no cell inside the ramp keep the nominal curve.

## S → power curve, aluminium, default rows (S max column past full mark), mild photo

| S | nominal | true | fitted factor | true factor | error | constrained |
|---:|---:|---:|---:|---:|---:|---|
| 15 % | 0.090 | 0.060 | 0.7807 | 0.6667 | 17.1 % | no |
| 29 % | 0.237 | 0.205 | 1.0000 (anchor) | 0.8659 | 15.5 % | yes |
| 43 % | 0.387 | 0.368 | 1.0963 | 0.9512 | 15.3 % | yes |
| 58 % | 0.548 | 0.538 | 1.1337 | 0.9809 | 15.6 % | yes |
| 72 % | 0.699 | 0.692 | 1.1434 | 0.9900 | 15.5 % | yes |
| 86 % | 0.849 | 0.846 | 1.1467 | 0.9959 | 15.1 % | yes |
| 100 % | 1.000 | 1.000 | 1.1021 | 1.0000 | 10.2 % | no |

markStart 0.6642 (true 0.572), markFull 2.714 (true 2.36). S → power: factors are relative to S 29.0 %, whose nominal power is taken as right (the S max column had fewer than two cells inside the ramp). Steps with no cell inside the ramp keep the nominal curve.

## Tolerances

- char: baseColor.l {"abs":1.5}; baseColor.a {"abs":1.5}; baseColor.b {"abs":1.5}; charColor.l {"abs":1.5}; charColor.a {"abs":1.5}; charColor.b {"abs":1.5}; toneStartJPerMm2 {"rel":0.06}; toneEndJPerMm2 {"rel":0.04}; toneGamma {"rel":0.03}; rampOnsetK {"rel":0.12}; ablationThresholdJPerMm2 {"rel":0.15}; depthMmPerJPerMm2 {"rel":0.05}; fireRisk.thresholdK {"interval":true}
- melt: baseColor.l {"abs":1.5}; baseColor.a {"abs":1.5}; baseColor.b {"abs":1.5}; frostColor.l {"abs":1.5}; frostColor.a {"abs":1.5}; frostColor.b {"abs":1.5}; frostStartJPerMm2 {"rel":0.04}; frostFullJPerMm2 {"rel":0.04}; removalThresholdJPerMm2 {"rel":0.04}; depthMmPerJPerMm2 {"rel":0.04}; rampOnsetK {"sigma":2}; fireRisk.thresholdK {"interval":true}
- bleach: baseColor.l {"abs":1.5}; baseColor.a {"abs":1.5}; baseColor.b {"abs":1.5}; markColor.l {"abs":1.5}; markColor.a {"abs":1.5}; markColor.b {"abs":1.5}; markStartJPerMm2 {"rel":0.03}; markFullJPerMm2 {"rel":0.02}

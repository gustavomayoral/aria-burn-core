# Machine catalog: sources (BURN-30)

> **Module figures are PROVISIONAL: they have not been checked against real burns.** Optical power, spot size and the power curve are vendor marketing figures or generic assumptions. No laser was used to make them. BURN-12 measures real machines and replaces them. Frame values are split: those marked `sourced` come from a manufacturer spec or a published `$$` dump, and everything else is an assumed common default.

A catalog machine is a **frame** (`frames/*.json`, schema `MachineFrame`) plus a **laser module** (`modules/*.json`, schema `LaserModule`). `combineMachine(frame, module)` in `src/contract/catalog.ts` builds the `MachineProfile` that the planner and the sim use. A frame lists the modules it takes, stock module first. A machine sold with interchangeable heads is one frame with several modules, not one entry per head.

Every value carries a status in the data itself (`fieldStatus`):

| Status | Meaning |
|---|---|
| `sourced` | Manufacturer spec, or a `$$` dump someone published for this machine. Linked below. |
| `provisional` | A vendor marketing figure (optical power, spot), the generic diode power curve, or an assumed GRBL default where nothing was published. |

A combined profile has `provenance.source = "provisional"` if any field is provisional, and its `notes` list every provisional field (for example `module.opticalPowerW`). `src/profiles/catalog.test.ts` checks the following:

- every file validates against TypeBox and the exported JSON Schema;
- every module marks power, spot and curve as provisional;
- every listed module exists;
- every frame × module pair runs a reference job through `interimSampler` and the CPU sim.

**Scope.** Only GRBL machines are included, because the emulator speaks GRBL only. xTool and other machines with their own firmware are left out. Bernie's catalog was **not** used as a source (BURN-34: we don't copy a competitor's data).

## Conventions shared by every entry

| Field | Value | Reasoning | Status unless noted |
|---|---|---|---|
| `powerCurve` | (0,0) (0.05,0) (0.10,0.04) (0.20,0.14) (1,1) | The generic NUBM-class diode curve from `../provisional/SOURCES.md` §1: threshold at 5–12 % of operating current, a soft knee, then linear. No vendor publishes a curve. Multi-diode (quad) heads use the same curve. | provisional |
| `spot` | vendor "W × H" | Read as the 1/e² diameters, with the long axis as `majorDiameterMm`. `combineMachine` converts each to σ = d / 4. If vendors actually quote FWHM, σ is about 1.7× larger (see `../provisional/SOURCES.md` §4 item 1). Unlike `machine-10w-diode.json`, the catalog keeps the vendor number unchanged; it does not widen the long axis from forum estimates. | provisional |
| `spot.angleDeg` | 90 | The long axis runs along machine Y, the most commonly reported orientation (`../provisional/SOURCES.md` §1). It depends on how the module is mounted. | provisional |
| `$30` `sMax` | 1000 | The GRBL diode default, and LightBurn's | sourced where a dump shows it |
| `$32` `laserMode` | true | Required for a diode laser on GRBL | sourced where a dump shows it |
| `$11` `junctionDeviationMm` | 0.01 | The GRBL 1.1 default | sourced where a dump shows it |
| `$110/$111` | vendor "max engraving speed" when no dump | A vendor's stated top speed is the nearest published figure to `$110`. It is marked sourced but is weaker than a dump. | — |
| `$120/$121` | 1000 mm/s² when no dump | Every published diode-machine dump we found (Sculpfun S9, S30; Creality Falcon2; Atomstack A5 Pro Plus) has 1000 | provisional |
| `$130/$131` | dump value, else the vendor work area | | provisional when copied from the work area |

## Frames

### <a id="sculpfun-s9"></a>Sculpfun S9: `sculpfun-s9`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 410 × 420 | [Sculpfun S9 product page](https://sculpfun.com/products/sculpfun-s9-laser-engraver), user manual. One reviewer measured 400 × 410 ([hagensieker](https://hagensieker.com/2023/04/06/sculpfun-s9-laser-review/)). | sourced |
| `$11 $30 $32 $110 $111 $120 $121 $130 $131` | 0.010, 1000, 1, 6000, 6000, 1000, 1000, 410, 400 | Factory `$$` dump: "factory default settings … when i first switched on" (post #3, [LightBurn forum: Sculpfun S9 GRBL settings](https://forum.lightburnsoftware.com/t/sculpfun-s9-gbrl-settings/79318)). The OP's dump in the same thread matches it, apart from the forum's number formatting. | sourced |

Modules: `sculpfun-s9-5w5`.

### <a id="sculpfun-s10"></a>Sculpfun S10: `sculpfun-s10`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 410 × 400 | [Sculpfun S10 listing](https://sculpfun.com/products/sculpfun-s10-10w-laser-engraver-air-pump-40x40cm-honeycomb-panel). Some retailers say 410 × 420. One user reports 385 × 390 usable with limit switches. | sourced |
| `$` settings | as the S9 | No published dump was found. It is the same vendor and the same 32-bit GRBL board generation as the S9. | provisional |

Modules: `sculpfun-s10-10w`.

### <a id="sculpfun-s30"></a>Sculpfun S30 / S30 Pro: `sculpfun-s30`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 410 × 400 | [Sculpfun S30 series blog](https://www.sculpfun.com/blogs/blog/sculpfun-s30-series), product pages. A review gives 380 × 385 usable ([Clever Creations](https://clevercreations.org/sculpfun-s30-announcement/)). | sourced |
| `$11 $30 $32 $110 $111 $120 $121` | 0.010, 1000, 1, 6000, 6000, 1000, 1000 | `$$` dump posted by MikeyH (#20) in [LightBurn forum: S30 Pro won't move from home](https://forum.lightburnsoftware.com/t/new-setup-sculpfun-s30-pro-setup-laser-wont-move-from-home-position/112034). The same user says his only change from factory settings was `$22=1`. | sourced (medium: the post doesn't make clear whether this is his machine's dump) |
| `$130 $131` | 380, 385 | The same dump. Two other users in [LightBurn forum: S30 Pro homing](https://forum.lightburnsoftware.com/t/sculpfun-s30-pro-issues-with-homing-and-strange-sound-at-the-edges/88769) say the usable travel is 380 × 385 and that the factory firmware ships a wrong generic value. | sourced |
| interchangeable modules | S30 5 W ↔ S30 Pro 10 W | Sculpfun says modules across the series are "mostly interchangeable", except the Pro Max (series blog above) | — |

Modules: `sculpfun-s30-pro-10w` (stock on the S30 Pro), `sculpfun-s30-5w` (stock on the S30).

### <a id="sculpfun-s30-pro-max"></a>Sculpfun S30 Pro Max: `sculpfun-s30-pro-max`

This is a separate frame. Sculpfun says the 20 W head fits only the Pro Max heavy-duty frame, and older heads don't fit it ([S30 series blog](https://www.sculpfun.com/blogs/blog/sculpfun-s30-series)).

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 410 × 400 | [S30 Pro Max product page](https://sculpfun.com/products/sculpfun-s30-pro-max-laser-engraver-machine). A review says 370 × 363 usable. | sourced |
| `$110 $111 $120 $121` | 6000, 6000, 1000, 1000 | Pro Max `$$` in [LightBurn forum: S30 Pro Max 900×920 frame](https://forum.lightburnsoftware.com/t/new-sculpfun-s30-pro-max-900x920-frame-hitting-sides/85857), read through a search summary, not directly. That machine has the extension kit, so its travel values are not used. | sourced (low) |
| `$11 $30 $32` | defaults | | provisional |
| `$130 $131` | 410 × 400 | Copied from the work area | provisional |

Modules: `sculpfun-s30-pro-max-20w`.

### <a id="ortur-lm2-pro-s2"></a>Ortur Laser Master 2 Pro S2: `ortur-lm2-pro-s2`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 400 × 400 | [Tiny Workshops review](https://tinyworkshops.com/ortur-laser-master-2-pro-s2-review), [The Maker's Chest listing](https://themakerschest.com/products/ortur-laser-master-2-pro-s2-diode-laser-engraver-and-cutter-5-10w). The original LM2 Pro is also 400 × 400 ([CNX Software](https://www.cnx-software.com/2021/06/02/ortur-laser-master-2-pro-laser-engraver-first-impressions/)). | sourced |
| `$110 $111` | 15000 | Vendor "250 mm/s, 15,000 mm/min" (The Maker's Chest listing; [Wellbots](https://www.wellbots.com/products/ortur-lm2-pro-s2-laser-engraving-cutting-machine-15-000mm-min-10w-5w)) | sourced (vendor max speed) |
| `$30 $32` | 1000, 1 | LM2 Pro owner confirming `$30=1000, $32=1` ([LightBurn forum](https://forum.lightburnsoftware.com/t/ortur-laser-master-2-pro-pulsing-instead-of-continuous-laser/189286)) | sourced |
| `$11 $120 $121 $130 $131` | defaults, work area | No published dump found. The [LightBurn forum thread on LM2 Pro X speed](https://forum.lightburnsoftware.com/t/change-x-axis-speed-for-ortur-laser-master-pro-2/56602) may have one, but it didn't load in this pass. | provisional |

Modules: `ortur-lu2-4-lf`, `ortur-lu2-10a`. The S2 was sold with either one, and the LU2-10A also fits the Laser Master 3.

### <a id="ortur-lm3"></a>Ortur Laser Master 3: `ortur-lm3`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 400 × 400 | Ortur FAQ: "Laser Master 3 10W has an engraving area of 400*400mm", and 20 W/40 W have 400 × 380 ([Ortur LM3 FAQ](https://ortur.net/blogs/ortur-blog-center/ortur-laser-master-3-frequently-asked-questions-1)). The frame entry uses the 10 W figure. | sourced |
| `$110 $111` | 20000 | Vendor "20,000 mm/min" ([Clever Creations spec table](https://clevercreations.org/ortur-laser-master-3-review-specs/)) | sourced (vendor max speed) |
| `$11 $30 $32 $120 $121 $130 $131` | defaults, work area | No published dump found | provisional |

Modules: `ortur-lu2-10a` (stock), `ortur-lm3-20w`. With the 20 W head the usable area drops to 400 × 380 (Ortur FAQ), but the frame keeps 400 × 400.

### <a id="atomstack-a5-a10-pro"></a>Atomstack A5 Pro / A10 Pro: `atomstack-a5-a10-pro`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 410 × 400 | [Atomstack A5 Pro product page](https://atomstack.com/products/atomstack-a5-pro-laser-engraver-40w-laser-engraving-cutting-machine-for-wood-metal-410x400mm). The A10 Pro is listed with the same area ([MechBlock A10 Pro](https://mechblock.in/?p=29813)). The A10 Pro **V2** lists 410 × 380 and is not covered here. | sourced |
| `$110 $111 $120 $121` | 6000, 6000, 1000, 1000 | A5 Pro Plus `$$` in [LightBurn forum: Atomstack A5 Pro Plus](https://forum.lightburnsoftware.com/t/atomstack-a5-pro-plus/139234), read through a search summary because the page returned 503 to a direct fetch | sourced (low) |
| `$11 $30 $32 $130 $131` | defaults, work area | | provisional |
| shared frame | A5 Pro and A10 Pro | Same work area and frame family, sold with different heads. This is **an assumption**, not a vendor compatibility statement. | — |

Modules: `atomstack-a5-pro-5w5`, `atomstack-a10-pro-10w`.

### <a id="atomstack-x20-pro"></a>Atomstack X20 Pro: `atomstack-x20-pro`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 400 × 400 | [Atomstack model comparison](https://atomstack.com/pages/model-comparison): 400 × 400, expandable to 850 × 400 | sourced |
| `$` settings | 6000 / 1000 / defaults | No X20 Pro dump found. These are the values from the brand's other dumps (A5 Pro Plus, S10 Pro). | provisional |

Modules: `atomstack-20w-quad`. Retailers use the X20/S20/A20 Pro names loosely for the same 20 W hardware.

### <a id="creality-falcon2"></a>Creality Falcon2: `creality-falcon2`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 400 × 415 | [Creality Falcon2 series comparison](https://crealityfalcon.com/blogs/product-tutorials-and-support/the-creality-falcon2-series-comparison). The 12 W, 22 W and 40 W versions are the same. | sourced |
| `$11 $30 $32 $130 $131` | 0.010, 1000, 1, 400, 415 | `$$` from danmatty1 in [LightBurn forum: Falcon2 S value](https://forum.lightburnsoftware.com/t/creality-falcon2-s-value-variable-power-issue/137714). The travel matches the vendor work area. | sourced |
| `$110 $111` | 25000, 25000 | The same dump has `$110=25000`, `$111=8000`. Another user in the thread calls the firmware "very modified" and says the two should match, so `$110` is mirrored to Y. | provisional |
| `$120 $121` | 1000 | The same dump. Kept provisional because the firmware is modified. | provisional |

Modules: `creality-falcon2-22w` (the most common version), `creality-falcon2-12w`, `creality-falcon2-40w`. Creality sells these as separate machines on one frame, so they are modelled as one frame with three modules.

### <a id="twotrees-ts2"></a>Two Trees TS2: `twotrees-ts2`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 450 × 450 | Spec list in [The Gadgeteer TS2 10 W review](https://the-gadgeteer.com/2023/01/03/twotrees-ts2-10w-diode-laser-engraver-review-a-powerful-auto-focusing-laser-makes-this-unit-great-for-newbies) (vendor-supplied sample) and [MBReviews](https://www.mbreviews.com/two-trees-ts2-laser-engraver-review-it-keeps-getting-better/). Some listings give 410 × 410 for the 20 W version. | sourced |
| `$110 $111` | 10000 | "Engraving Speed: 10000 mm/min" (The Gadgeteer spec list) | sourced (vendor max speed via review) |
| `$11 $30 $32 $120 $121 $130 $131` | defaults, work area | No published dump found | provisional |

Modules: `twotrees-ts2-10w`.

### <a id="longer-ray5"></a>Longer Ray5 (5 W / 10 W): `longer-ray5`

| Field | Value | Source | Status |
|---|---|---|---|
| work area | 400 × 400 | Spec table in [Longer: Ray5 20W vs 10W vs 5W](https://www.longer3d.com/blogs/academy/ray5-laser-engraver-5w-10w-20w) | sourced |
| `$` settings | 6000 / 1000 / defaults | No published dump found | provisional |

Modules: `longer-ray5-10w`, `longer-ray5-5w`. The Ray5 **20 W** is left out: Longer lists it at 375 × 375 (other Longer pages say 400 × 365), so it is probably a different frame or head offset. Add it as its own frame once its travel is sourced.

## Modules

`opticalPowerW`, `spot` and `powerCurve` are provisional in every module. `wavelengthNm` is sourced where a vendor or retail spec states it.

| id | Optical W | Spot (major × minor, mm) | λ (nm) | Source | Notes |
|---|---|---|---|---|---|
| <a id="sculpfun-s9-5w5"></a>`sculpfun-s9-5w5` | 5.5 | 0.06 × 0.06 | 455 | [Sculpfun S9 page](https://sculpfun.com/products/sculpfun-s9-laser-engraver); λ from [3ddevice listing](https://3ddevice.com.ua/en/product/sculpfun-s9-5.5w-laser-engraver/) | Another listing says 445 nm |
| <a id="sculpfun-s10-10w"></a>`sculpfun-s10-10w` | 10 | 0.08 × 0.08 | 455 | λ from [Sculpfun S10 blog](https://sculpfun.com/blogs/blog/sculpfun-s10); spot from one review ([MechBlock](https://mechblock.in/sculpfun-s10)) | The manual describes a rectangular spot but its dimensions weren't found |
| <a id="sculpfun-s30-5w"></a>`sculpfun-s30-5w` | 5 | 0.08 × 0.06 | 455 | Power from the [S30 series blog](https://www.sculpfun.com/blogs/blog/sculpfun-s30-series) | **No vendor spot found**; copied from the S30 Pro |
| <a id="sculpfun-s30-pro-10w"></a>`sculpfun-s30-pro-10w` | 10 | 0.08 × 0.06 | 455 | [S30 Pro product page](https://sculpfun.com/products/sculpfun-s30-pro-laser-engraving-machine-10w), `../provisional/SOURCES.md` §1 | `machine-10w-diode.json` widens the long axis to 0.12 from forum reports; the catalog keeps the vendor 0.08 |
| <a id="sculpfun-s30-pro-max-20w"></a>`sculpfun-s30-pro-max-20w` | 20 | 0.10 × 0.08 | 455 | [S30 Pro Max page](https://sculpfun.com/products/sculpfun-s30-pro-max-laser-engraver-machine): "0.08x0.1mm", "455±5nm" | |
| <a id="ortur-lu2-4-lf"></a>`ortur-lu2-4-lf` | 5.5 | 0.10 × 0.05 | 445 | Power from [Wellbots](https://www.wellbots.com/products/ortur-lm2-pro-s2-laser-engraving-cutting-machine-15-000mm-min-10w-5w) ("5–5.5 W optical"); spot from [The Maker's Chest](https://themakerschest.com/products/ortur-laser-master-2-pro-s2-diode-laser-engraver-and-cutter-5-10w) (module not named); λ from [CNX Software](https://www.cnx-software.com/2021/06/02/ortur-laser-master-2-pro-laser-engraver-first-impressions/) | Spot may belong to the LU2-10A |
| <a id="ortur-lu2-10a"></a>`ortur-lu2-10a` | 10 | 0.10 × 0.05 | 445 | Power from [manuals.plus: OLM2 Pro S2 10W](https://manuals.plus/asin/B0DRYHB5JN); spot from the LM3 10 W spec ([Clever Creations](https://clevercreations.org/ortur-laser-master-3-review-specs/)) | |
| <a id="ortur-lm3-20w"></a>`ortur-lm3-20w` | 20 | 0.08 × 0.08 | 445 (assumed) | LM3 20 W spec ([Clever Creations](https://clevercreations.org/ortur-laser-master-3-review-specs/)) | Module part number not found |
| <a id="atomstack-a5-pro-5w5"></a>`atomstack-a5-pro-5w5` | 5.5 | 0.08 × 0.08 | 455 (assumed) | Power from [techreviewer: "4.5–5.5 W optical"](https://en.techreviewer.de/?p=29385) | **No vendor spot found**; assumed |
| <a id="atomstack-a10-pro-10w"></a>`atomstack-a10-pro-10w` | 10 | 0.15 × 0.08 | 455 (assumed) | [MechBlock A10 Pro review](https://mechblock.in/?p=29813): M40 module, "0.08 X 0.15mm" | |
| <a id="atomstack-20w-quad"></a>`atomstack-20w-quad` | 20 | 0.10 × 0.08 | 455 (assumed) | [manuals.plus: S20 Pro](https://manuals.plus/asin/B0B9CBPGZ5): "0.08 x 0.1mm" | Quad-diode, beam-combined |
| <a id="creality-falcon2-12w"></a>`creality-falcon2-12w` | 12 | 0.08 × 0.06 | 455 | [Falcon2 series comparison](https://crealityfalcon.com/blogs/product-tutorials-and-support/the-creality-falcon2-series-comparison) | Least certain row of that page |
| <a id="creality-falcon2-22w"></a>`creality-falcon2-22w` | 22 | 0.10 × 0.08 | 455 | same | |
| <a id="creality-falcon2-40w"></a>`creality-falcon2-40w` | 40 | 0.12 × 0.08 | 455 | same | |
| <a id="twotrees-ts2-10w"></a>`twotrees-ts2-10w` | 10 | 0.08 × 0.08 | 445 | [The Gadgeteer spec list](https://the-gadgeteer.com/2023/01/03/twotrees-ts2-10w-diode-laser-engraver-review-a-powerful-auto-focusing-laser-makes-this-unit-great-for-newbies): "10W (10000mw)", ".08mm x .08mm", "445±5nm" | |
| <a id="longer-ray5-5w"></a>`longer-ray5-5w` | 5 | 0.08 × 0.08 | 450 | [Longer Ray5 spec table](https://www.longer3d.com/blogs/academy/ray5-laser-engraver-5w-10w-20w) | |
| <a id="longer-ray5-10w"></a>`longer-ray5-10w` | 10 | 0.06 × 0.06 | 450 | same | Marketing copy says "10–12 W"; the spec table says 10 |

## What BURN-12 and BURN-31 should check first

1. **Spot sizes**: these are the most consequential values, and the vendors' figures have the weakest basis (see `../provisional/SOURCES.md` §4 item 1). Several "square" spots (0.06 × 0.06, 0.08 × 0.08) are almost certainly rectangular in practice.
2. **`$120` acceleration**: most frames use the 1000 mm/s² seen in four dumps. Ortur and Creality machines may ship with higher values.
3. **Rows read only through search summaries**: S30 Pro Max `$110/$120` and Atomstack A5 Pro Plus `$110/$120`. Re-read these from the forum pages, or get a real `$$` dump when BURN-31's import lands.
4. **Optical power**: every rating is the vendor's claim. Real modules often measure below it.

# aria-burn-core

TypeScript simulation core for the Aria Burn material burn model: deposit, blur, response kinds, outputs and tiling.

It is consumed by the [aria-burn](../aria-burn) app and will later be embedded in Aria Studio.

## Layout

- `src/contract/` — the v1 simulation contract (interfaces and types, COD-260)
  - `schema/contract.schema.json` — JSON Schema bundle the Rust side generates its types from (`typify`)
  - `schema/sample-batch-layout.json` — binary sample batch layout (field order, stride, units, endianness)
  - `fixtures/` — conformance examples the Rust tests read and write back
- `src/sim/` — the simulation pipeline (COD-264): interim sampler, sample store, deposit, blur, response kinds, verdict, tiling, scrub, live jobs, hover readout; `gl/` is the WebGL2 path, `cpu.ts` the CPU reference. See [docs/pipeline.md](docs/pipeline.md).
- `src/calibration/` — calibration pattern generators (BURN-32), exported as `aria-burn-core/calibration`: power × speed grid, equal-energy pairs, line-interval raster, sharp corners, small vs. large fill, registration & colour-card marks. `generatePattern(kind, machine, material)` returns GRBL G-code, the job model the parser makes of it, and a record of every cell's settings (for "pick the best cell", the photo fit in BURN-15 and the BURN-12 lab protocol). New patterns go in `patterns.ts` and `PATTERNS` (see `generate.ts`).
  - Photo fit (BURN-15): the reference card, card and fiducial detection, light and colour correction, per-cell Lab sampling, the forward model and the material fit, plus synthetic photos for round-trip tests. See [docs/photo-fit.md](docs/photo-fit.md).
- `bench/` — WebGL2 benchmark page (`pnpm bench`) for the COD-251/252 criteria
- `src/testing/golden.ts` — golden-image harness; committed goldens in `src/testing/golden/`
- `docs/` — design notes for the core

## Contract

Types that cross the Rust ↔ webview boundary are defined once with TypeBox in `src/contract/`. After changing them, regenerate and commit the artefacts:

```sh
pnpm contract:export
pnpm check
```

`pnpm check` fails if the committed schema, layout or binary fixture is stale.

## Golden images

Render outputs (RGBA images, or float fields stored as 16-bit grayscale PNGs) are compared with committed goldens via `compareRgbaGolden` / `compareFieldGolden`. On a mismatch the test writes `<name>.actual.png` and `<name>.diff.png` beside the golden (CI uploads them as an artifact). After an intended change, re-bless and review the PNG diff before committing:

```sh
pnpm golden:update
```

## Toolchain

Node 26 (`.nvmrc`, `engines.node`) and pnpm 9.15.9 (`packageManager`). Node 26 ships no corepack, so install pnpm globally (`npm i -g pnpm@9.15.9`). CI runs `pnpm check` on macOS and Windows.

## License

MIT — see [LICENSE](LICENSE).

This package must never contain GRBL-derived or other GPL-licensed code. The GRBL planner port lives in `aria-burn` (GPLv3).

# aria-burn-core

TypeScript simulation core for the Laser Sim material burn model: deposit, blur, response kinds, outputs and tiling.

It is consumed by the [aria-burn](../aria-burn) app and will later be embedded in Aria Studio.

## Layout

- `src/contract/` — the v1 simulation contract (interfaces and types, COD-260)
  - `schema/contract.schema.json` — JSON Schema bundle the Rust side generates its types from (`typify`)
  - `schema/sample-batch-layout.json` — binary sample batch layout (field order, stride, units, endianness)
  - `fixtures/` — conformance examples the Rust tests read and write back
- `docs/` — design notes for the core

## Contract

Types that cross the Rust ↔ webview boundary are defined once with TypeBox in `src/contract/`. After changing them, regenerate and commit the artefacts:

```sh
pnpm contract:export
pnpm check
```

`pnpm check` fails if the committed schema, layout or binary fixture is stale.

## License

MIT — see [LICENSE](LICENSE).

This package must never contain GRBL-derived or other GPL-licensed code. The GRBL planner port lives in `aria-burn` (GPLv3).

# aria-burn-core

TypeScript simulation core for the Laser Sim material burn model: deposit, blur, response kinds, outputs and tiling.

It is consumed by the [aria-burn](../aria-burn) app and will later be embedded in Aria Studio.

## Layout

- `src/contract/` — the v1 simulation contract (interfaces and types, COD-260)
- `docs/` — design notes for the core

## License

MIT — see [LICENSE](LICENSE).

This package must never contain GRBL-derived or other GPL-licensed code. The GRBL planner port lives in `aria-burn` (GPLv3).

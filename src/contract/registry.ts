// The shared schemas, the JSON Schema bundle built from them, and runtime
// validation. `schema/contract.schema.json` is generated from this file by
// `pnpm contract:export`; a test fails if the committed copy drifts.

import { FormatRegistry, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { CONTRACT_VERSION } from './common.ts'
import { JobModel } from './job.ts'
import { MachineProfile } from './machine.ts'
import { MaterialProfile } from './material.ts'
import { ChannelEvent, Command } from './messages.ts'

// TypeBox rejects string formats it doesn't know; uint32 is on integers and is
// only a hint for typify.
if (!FormatRegistry.Has('date-time'))
  FormatRegistry.Set('date-time', (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v))

/** Root types the Rust side generates. Everything they reference lands in `$defs` too. */
export const ROOT_SCHEMAS = { JobModel, MachineProfile, MaterialProfile, ChannelEvent, Command } as const

export const CONTRACT_SCHEMA_ID = `https://aria-burn.dev/contract/v${CONTRACT_VERSION}/contract.schema.json`

/**
 * Bundle every named schema (one with `$id`) into `$defs`, replacing nested
 * occurrences with `$ref`. Tagged unions become `oneOf` so typify emits Rust
 * enums with `#[serde(tag = ...)]`; unions of string literals become `enum`.
 */
export function buildContractSchema(): Record<string, unknown> {
  const defs: Record<string, unknown> = {}

  const visit = (node: unknown, isDefRoot: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => visit(n, false))
    if (node === null || typeof node !== 'object') return node
    const obj = node as Record<string, unknown>
    const id = obj.$id
    if (typeof id === 'string' && !isDefRoot) {
      if (!(id in defs)) {
        defs[id] = null // reserve to break cycles and keep first-seen order
        defs[id] = visit(obj, true)
      }
      return { $ref: `#/$defs/${id}` }
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$id') continue
      out[key] = visit(value, false)
    }
    if (Array.isArray(out.anyOf) && isTaggedUnion(obj.anyOf as unknown[])) {
      out.oneOf = out.anyOf
      delete out.anyOf
    } else if (Array.isArray(out.anyOf) && isStringLiteralUnion(out.anyOf)) {
      out.type = 'string'
      out.enum = out.anyOf.map((v) => (v as { const: string }).const)
      delete out.anyOf
    }
    return out
  }

  for (const schema of Object.values(ROOT_SCHEMAS)) visit(schema, false)

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: CONTRACT_SCHEMA_ID,
    title: 'aria-burn v1 simulation contract',
    description: 'Generated from aria-burn-core/src/contract by `pnpm contract:export`. Do not edit.',
    $defs: sortKeys(defs),
  }
}

/** Union of objects each with a required literal under the same key (kind/type). */
function isTaggedUnion(variants: unknown[]): boolean {
  const tagOf = (v: unknown): string | undefined => {
    const props = (v as { properties?: Record<string, { const?: unknown }> }).properties
    if (!props) return undefined
    return ['kind', 'type'].find((k) => props[k]?.const !== undefined)
  }
  const tags = variants.map(tagOf)
  return tags.length > 1 && tags[0] !== undefined && tags.every((t) => t === tags[0])
}

function isStringLiteralUnion(variants: unknown[]): boolean {
  return variants.every((v) => typeof (v as { const?: unknown }).const === 'string')
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
}

export interface ValidationIssue {
  path: string
  message: string
}

/** Validate a value against one of the shared schemas. Empty array means valid. */
export function validate(schema: TSchema, value: unknown): ValidationIssue[] {
  return [...Value.Errors(schema, value)].map((e) => ({ path: e.path || '/', message: e.message }))
}

export function assertValid<T extends TSchema>(schema: T, value: unknown, label = schema.$id ?? 'value'): void {
  const issues = validate(schema, value)
  if (issues.length) throw new Error(`${label} invalid:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`)
}

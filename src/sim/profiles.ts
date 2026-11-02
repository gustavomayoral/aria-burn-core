// SPDX-License-Identifier: MIT
// Profile loading. Profiles are data files (COD-266 provisional, COD-257
// calibrated), never hard-coded: every load validates against the contract's
// TypeBox schema and the ordering checks JSON Schema can't express.

import {
  MachineProfile,
  MaterialProfile,
  assertValid,
  checkMachineProfile,
  checkMaterialProfile,
  type MachineProfile as MachineProfileT,
  type MaterialProfile as MaterialProfileT,
} from '../contract/index.ts'

const parse = (data: unknown): unknown => (typeof data === 'string' ? JSON.parse(data) : data)

function rejectProblems(label: string, problems: string[]): void {
  if (problems.length) throw new Error(`${label} invalid:\n${problems.map((p) => `  ${p}`).join('\n')}`)
}

/** Parse (if given text) and validate a material profile. Throws on any problem. */
export function loadMaterialProfile(data: unknown, label = 'MaterialProfile'): MaterialProfileT {
  const value = parse(data)
  assertValid(MaterialProfile, value, label)
  const profile = value as MaterialProfileT
  rejectProblems(label, checkMaterialProfile(profile))
  return profile
}

/** Parse (if given text) and validate a machine profile. Throws on any problem. */
export function loadMachineProfile(data: unknown, label = 'MachineProfile'): MachineProfileT {
  const value = parse(data)
  assertValid(MachineProfile, value, label)
  const profile = value as MachineProfileT
  rejectProblems(label, checkMachineProfile(profile))
  return profile
}

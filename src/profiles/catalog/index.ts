// SPDX-License-Identifier: MIT
// The machine catalog as data (BURN-31): every frame and module file, validated
// on import, so an app can list them without reading the directory. catalog.test.ts
// checks this list matches the files on disk.

import { checkCatalog, type LaserModule, type MachineFrame } from '../../contract/index.ts'
import { loadLaserModule, loadMachineFrame } from '../../sim/profiles.ts'
import f0 from './frames/atomstack-a5-a10-pro.json'
import f1 from './frames/atomstack-x20-pro.json'
import f2 from './frames/creality-falcon2.json'
import f3 from './frames/longer-ray5.json'
import f4 from './frames/ortur-lm2-pro-s2.json'
import f5 from './frames/ortur-lm3.json'
import f6 from './frames/sculpfun-s10.json'
import f7 from './frames/sculpfun-s30-pro-max.json'
import f8 from './frames/sculpfun-s30.json'
import f9 from './frames/sculpfun-s9.json'
import f10 from './frames/twotrees-ts2.json'
import m0 from './modules/atomstack-20w-quad.json'
import m1 from './modules/atomstack-a10-pro-10w.json'
import m2 from './modules/atomstack-a5-pro-5w5.json'
import m3 from './modules/creality-falcon2-12w.json'
import m4 from './modules/creality-falcon2-22w.json'
import m5 from './modules/creality-falcon2-40w.json'
import m6 from './modules/longer-ray5-10w.json'
import m7 from './modules/longer-ray5-5w.json'
import m8 from './modules/ortur-lm3-20w.json'
import m9 from './modules/ortur-lu2-10a.json'
import m10 from './modules/ortur-lu2-4-lf.json'
import m11 from './modules/sculpfun-s10-10w.json'
import m12 from './modules/sculpfun-s30-5w.json'
import m13 from './modules/sculpfun-s30-pro-10w.json'
import m14 from './modules/sculpfun-s30-pro-max-20w.json'
import m15 from './modules/sculpfun-s9-5w5.json'
import m16 from './modules/twotrees-ts2-10w.json'

const frameFiles: [string, unknown][] = [
  ['atomstack-a5-a10-pro.json', f0],
  ['atomstack-x20-pro.json', f1],
  ['creality-falcon2.json', f2],
  ['longer-ray5.json', f3],
  ['ortur-lm2-pro-s2.json', f4],
  ['ortur-lm3.json', f5],
  ['sculpfun-s10.json', f6],
  ['sculpfun-s30-pro-max.json', f7],
  ['sculpfun-s30.json', f8],
  ['sculpfun-s9.json', f9],
  ['twotrees-ts2.json', f10],
]
const moduleFiles: [string, unknown][] = [
  ['atomstack-20w-quad.json', m0],
  ['atomstack-a10-pro-10w.json', m1],
  ['atomstack-a5-pro-5w5.json', m2],
  ['creality-falcon2-12w.json', m3],
  ['creality-falcon2-22w.json', m4],
  ['creality-falcon2-40w.json', m5],
  ['longer-ray5-10w.json', m6],
  ['longer-ray5-5w.json', m7],
  ['ortur-lm3-20w.json', m8],
  ['ortur-lu2-10a.json', m9],
  ['ortur-lu2-4-lf.json', m10],
  ['sculpfun-s10-10w.json', m11],
  ['sculpfun-s30-5w.json', m12],
  ['sculpfun-s30-pro-10w.json', m13],
  ['sculpfun-s30-pro-max-20w.json', m14],
  ['sculpfun-s9-5w5.json', m15],
  ['twotrees-ts2-10w.json', m16],
]

/** File names of the catalog entries, for the test that checks the list is complete. */
export const CATALOG_FILES = { frames: frameFiles.map(([f]) => f), modules: moduleFiles.map(([f]) => f) }

/** Every catalog frame, sorted by display name. */
export const CATALOG_FRAMES: readonly MachineFrame[] = frameFiles
  .map(([f, v]) => loadMachineFrame(v, f))
  .sort((a, b) => a.name.localeCompare(b.name))

/** Every catalog laser module. */
export const CATALOG_MODULES: readonly LaserModule[] = moduleFiles.map(([f, v]) => loadLaserModule(v, f))

{
  const problems = checkCatalog(CATALOG_FRAMES, CATALOG_MODULES)
  if (problems.length) throw new Error(`machine catalog invalid:\n  ${problems.join('\n  ')}`)
}

export const findFrame = (id: string): MachineFrame | undefined => CATALOG_FRAMES.find((f) => f.id === id)
export const findModule = (id: string): LaserModule | undefined => CATALOG_MODULES.find((m) => m.id === id)

/** The modules a frame takes, stock module first. */
export const modulesForFrame = (frame: MachineFrame): LaserModule[] =>
  frame.modules.map((id) => findModule(id)).filter((m): m is LaserModule => m !== undefined)

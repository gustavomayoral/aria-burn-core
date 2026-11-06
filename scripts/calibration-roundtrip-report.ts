// SPDX-License-Identifier: MIT
// Photo-fit round-trip report (BURN-15): runs every round trip the tests run
// and writes the recovered-vs-true tables to a Markdown file.
//   pnpm tsx scripts/calibration-roundtrip-report.ts docs/bench/burn-15-roundtrip-macos-m1.md [photo-dir]
// With photo-dir, the synthetic photos are saved there as PNG (not committed).

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { interpolateCurve } from '../src/contract/index.ts'
import { CONDITIONS, MAX_MEAN_DELTA_E, TOLERANCES, check, machine, makeTruth, roundTrip } from '../src/testing/calibration-roundtrip.ts'

const out = process.argv[2] ?? 'docs/bench/burn-15-roundtrip.md'
const photos = process.argv[3]
if (photos) mkdirSync(photos, { recursive: true })
const lines: string[] = []
const say = (s = '') => {
  lines.push(s)
  console.log(s)
}
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4))

say('# BURN-15 photo-fit round trip')
say()
say(`Generated ${new Date().toISOString()} on ${process.platform}/${process.arch}, Node ${process.version}.`)
say('Truth: each provisional profile moved away from its starting values (calibration-roundtrip.ts `trueMaterial`); the fit starts from the provisional profile.')
say('Grid: the default power × speed grid (7 × 6 cells) for the provisional 10 W diode. Render at 25 µm, fit at 10 µm. Thermal step: CPU reference on a 0.5 mm grid with 2 s bins, for truth and fit alike.')
say('Depths: three gauge readings (most burned cell, a quarter and half way down the depth ranking) with −0.005, 0 and +0.005 mm error. Fire: the cells whose true bulk temperature reaches the true threshold are flagged.')
say()
say('Conditions:')
for (const [name, c] of Object.entries(CONDITIONS)) say(`- **${name}**: ${JSON.stringify(c)}`)
say()

for (const file of ['birch-ply.json', 'black-cast-acrylic.json', 'black-anodized-aluminum.json']) {
  const t0 = performance.now()
  const truth = makeTruth(file)
  const kind = truth.truth.response.kind
  say(`## ${truth.start.name} — ${kind}`)
  say()
  if (truth.depths.length) say(`Depth entries: ${truth.depths.map((d) => `${d.cellId} ${d.depthMm} mm`).join(', ')}.`)
  if (truth.fireCellIds) say(`Flamed cells: ${truth.fireCellIds.join(', ') || 'none'}.`)
  say(`Truth setup ${((performance.now() - t0) / 1000).toFixed(1)} s.`)
  say()
  for (const [name, c] of Object.entries(CONDITIONS)) {
    const t1 = performance.now()
    const rt = roundTrip(truth, c)
    const rows = check(truth, rt)
    const s = ((performance.now() - t1) / 1000).toFixed(1)
    say(`### ${name} photo`)
    say()
    say(
      `Mean ΔE00 fitted vs photographed ${rt.fit.meanDeltaE.toFixed(2)} (max ${rt.fit.maxDeltaE.toFixed(2)}, limit ${MAX_MEAN_DELTA_E}); card patches after correction ${rt.analysis.correction.meanPatchDeltaE.toFixed(2)}; thermal runs ${rt.fit.thermalIterations}; ${s} s.`,
    )
    if (rt.analysis.warnings.length) say(`Warnings: ${rt.analysis.warnings.join(' ')}`)
    say()
    say('| field | true | fitted | error | tolerance | pass |')
    say('|---|---:|---:|---:|---|---|')
    for (const r of rows) say(`| ${r.name} | ${fmt(r.truth)} | ${fmt(r.fitted)} | ${r.error} | ${r.tolerance} | ${r.pass ? 'yes' : '**no**'} |`)
    const onset = rt.fit.parameters.find((p) => p.name.startsWith('rampOnsetK'))
    if (onset) say(`\nrampOnsetK − ambient fitted σ: ${onset.sigma?.toFixed(0)} K${onset.constrained ? '' : ' (prior dominates)'}.`)
    if (rt.fit.fire) say(`Fire: ${rt.fit.fire.note}`)
    if (rt.fit.depth) say(`Depth: ${rt.fit.depth.note}`)
    say()
    if (photos) {
      const png = new PNG({ width: rt.photo.photo.width, height: rt.photo.photo.height })
      png.data = Buffer.from(rt.photo.photo.data)
      writeFileSync(join(photos, `${kind}-${name}.png`), PNG.sync.write(png))
    }
  }
}

// S → power curve
{
  const trueCurve = [{ s: 0, power: 0 }, { s: 0.05, power: 0 }, { s: 0.1, power: 0.02 }, { s: 0.2, power: 0.1 }, { s: 0.5, power: 0.45 }, { s: 1, power: 1 }]
  const trueMachine = { ...machine, powerCurve: trueCurve }
  for (const [label, grid] of [
    ['fast rows (S max on the ramp)', { feedsMmPerMin: [10000, 8000, 6400, 5000, 4000, 3000] }],
    ['default rows (S max column past full mark)', undefined],
  ] as const) {
    const t = makeTruth('black-anodized-aluminum.json', { trueMachine, ...(grid ? { grid } : {}) })
    const rt = roundTrip(t, CONDITIONS.mild!, { fitPowerCurve: true, trueMachine })
    say(`## S → power curve, aluminium, ${label}, mild photo`)
    say()
    say('| S | nominal | true | fitted factor | true factor | error | constrained |')
    say('|---:|---:|---:|---:|---:|---:|---|')
    for (const f of rt.fit.powerFactors!) {
      const want = interpolateCurve(trueCurve, f.sFraction) / interpolateCurve(machine.powerCurve, f.sFraction)
      say(
        `| ${(f.sFraction * 100).toFixed(0)} % | ${interpolateCurve(machine.powerCurve, f.sFraction).toFixed(3)} | ${interpolateCurve(trueCurve, f.sFraction).toFixed(3)} | ${f.factor.toFixed(4)}${f.anchor ? ' (anchor)' : ''} | ${want.toFixed(4)} | ${((f.factor / want - 1) * 100).toFixed(1)} % | ${f.constrained ? 'yes' : 'no'} |`,
      )
    }
    const r = rt.fit.material.response
    const tr = t.truth.response
    if (r.kind === 'bleach' && tr.kind === 'bleach')
      say(`\nmarkStart ${fmt(r.markStartJPerMm2)} (true ${tr.markStartJPerMm2}), markFull ${fmt(r.markFullJPerMm2)} (true ${tr.markFullJPerMm2}). ${rt.fit.notes.join(' ')}`)
    say()
  }
}

say('## Tolerances')
say()
for (const [k, tol] of Object.entries(TOLERANCES)) say(`- ${k}: ${Object.entries(tol).map(([f, t]) => `${f} ${JSON.stringify(t)}`).join('; ')}`)
writeFileSync(out, lines.join('\n') + '\n')

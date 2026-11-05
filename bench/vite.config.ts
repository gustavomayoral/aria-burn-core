// SPDX-License-Identifier: MIT
// Bench server config (`pnpm bench` serves bench/ as the root, so Vite loads this file).
// POST /__bench-report prints a finished report to this server's log, so a run
// in a webview with no devtools or clipboard (the Tauri app, BURN-33) still
// gets its numbers out. Open the page with ?auto=live (or run, fine, thermal, tiles, stages, pitch, detail;
// comma-separated) to start runs on load and report each one.

import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

function benchReport(): Plugin {
  return {
    name: 'bench-report',
    configureServer(server) {
      server.middlewares.use('/__bench-report', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => (body += chunk))
        req.on('end', () => {
          console.log(`\n----- bench report -----\n${body}\n----- end bench report -----`)
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

export default defineConfig({ plugins: [benchReport()] })

/**
 * Launch a SECOND Mirante window as a separate participant, so one person can
 * test a two-person room alone.
 *
 * It attaches to the dev server that `npm run dev` is already serving, and
 * points Electron at its own `--user-data-dir`. The separate profile matters
 * for three reasons:
 *
 *   - the remembered name and room live in localStorage, which is per-profile,
 *     so the two windows do not fight over the same identity
 *   - the log file lives under userData, so each instance writes its own
 *   - camera and microphone permission state stays independent
 *
 * Usage, in two terminals:
 *
 *     npm run signal      # terminal 1
 *     npm run dev         # terminal 2
 *     npm run peer        # terminal 3, once the window from `dev` is up
 *
 * Then join the SAME room name with DIFFERENT people names.
 *
 * Note on testing alone: share a window rather than your whole screen, or the
 * second window will be showing a picture of itself showing a picture of
 * itself. Pick something boring, like a text editor.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const RENDERER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'
const PROFILE = join(ROOT, '.peer-profile')

const entry = join(ROOT, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error('out/main/index.js is missing — run `npm run dev` (or `npm run build`) first.')
  process.exit(1)
}

// Fail fast with a clear message instead of a confusing blank window.
const response = await fetch(RENDERER_URL).catch(() => null)
if (!response?.ok) {
  console.error(`No dev server at ${RENDERER_URL} — start \`npm run dev\` first.`)
  process.exit(1)
}

mkdirSync(PROFILE, { recursive: true })

const electron = require('electron')
console.log(`second participant → ${RENDERER_URL}`)
console.log(`profile           → ${PROFILE}`)

const child = spawn(electron, [ROOT, `--user-data-dir=${PROFILE}`], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RENDERER_URL: RENDERER_URL, NODE_ENV: 'development' }
})

child.on('close', (code) => process.exit(code ?? 0))

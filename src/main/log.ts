import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

/**
 * File logger.
 *
 * `electron-vite dev` does not reliably surface the main process's stdout, and
 * the renderer's console lives inside DevTools where nobody is looking when
 * something fails silently. Both ends land in one file instead, which is the
 * only way to debug a capture failure that happens on someone else's machine.
 *
 * Path is printed on startup and lives next to the app's user data.
 */

let logPath: string | null = null

export function logFile(): string {
  if (!logPath) logPath = join(app.getPath('userData'), 'logs', 'mirante.log')
  return logPath
}

function write(line: string): void {
  const path = logFile()
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`, 'utf8')
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

export function log(scope: string, ...parts: unknown[]): void {
  const text = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ')
  const line = `[${stamp()}] [${scope}] ${text}`
  console.log(line)
  write(line)
}

export function startLogging(window: BrowserWindow): void {
  const path = logFile()
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Truncate per run: a stale log is worse than no log when debugging.
    writeFileSync(path, '', 'utf8')
  } catch {
    // Non-fatal.
  }

  log('app', `Mirante ${app.getVersion()} — log: ${path}`)

  // Mirror the renderer's console so a failure in the UI is visible here too.
  window.webContents.on('console-message', (_event, level, message, line, source) => {
    const name = ['debug', 'info', 'warn', 'error'][level] ?? 'log'
    const where = source ? ` (${source.split('/').pop()}:${line})` : ''
    write(`[${stamp()}] [renderer:${name}] ${message}${where}`)
  })

  window.webContents.on('render-process-gone', (_event, details) =>
    log('renderer', 'process gone:', details.reason)
  )

  process.on('uncaughtException', (error) => log('main', 'uncaught:', error.stack ?? String(error)))
  process.on('unhandledRejection', (reason) => log('main', 'unhandled rejection:', String(reason)))
}

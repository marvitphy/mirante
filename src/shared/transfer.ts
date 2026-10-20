
export const OFFER_TTL_MS = 15_000

export const CHUNK_BYTES = 64 * 1024

export const HIGH_WATER_BYTES = 4 * 1024 * 1024
export const LOW_WATER_BYTES = 1 * 1024 * 1024

export const MAX_INCOMING_SESSIONS = 3

export const MAX_FILES_PER_OFFER = 64

export const MAX_NAME_CHARS = 120

export const PACE_MS_WHEN_LIVE = 50

export const PROGRESS_TICK_MS = 250

export function sanitizeName(raw: string): string {
  const base = String(raw).split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  return truncateName(cleaned, MAX_NAME_CHARS) || 'arquivo'
}

export function dedupeName(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const { stem, ext } = splitExtension(name)
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function chunkCount(size: number): number {
  return size > 0 ? Math.ceil(size / CHUNK_BYTES) : 0
}

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  const hasExt = dot > 0 && name.length - dot <= 16
  return hasExt ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

function truncateName(name: string, max: number): string {
  if (name.length <= max) return name
  const { stem, ext } = splitExtension(name)
  const keptExt = ext.length < max ? ext : ''
  return stem.slice(0, max - keptExt.length) + keptExt
}

export interface TransferFileRef {
  fileId: string
  name: string
  size: number
}

export interface TransferTarget extends TransferFileRef {
  path: string
}

export interface TransferOpenResult {
  token: string
  targets: TransferTarget[]
}

export interface TransferCloseResult {
  paths: string[]
  hashes: Record<string, string>
  error?: string
}

export interface TransferWriteResult {
  error?: string
}

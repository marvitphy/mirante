/** Formatting helpers for telemetry. Every output is fixed-width-friendly. */

export function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond <= 0) return '—'
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1_000)} kb/s`
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mb/s`
}

export function formatMs(ms: number): string {
  return ms > 0 ? `${Math.round(ms)} ms` : '—'
}

export function formatLoss(ratio: number): string {
  if (ratio <= 0) return '0%'
  return ratio < 0.001 ? '<0,1%' : `${(ratio * 100).toFixed(1).replace('.', ',')}%`
}

export function formatResolution(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width}×${height}` : '—'
}

export function formatVolume(volume: number): string {
  return `${Math.round(volume * 100)}%`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace('.', ',')} ${units[unit]}`
}

/** Elapsed time as m:ss, or h:mm:ss past an hour. */
export function formatElapsed(sinceMs: number): string {
  const total = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

export type SignalGrade = 'good' | 'fair' | 'poor' | 'dead'

/**
 * Collapse RTT and loss into one grade.
 *
 * Thresholds chosen for interactive viewing, not for a speed test: above
 * ~150 ms a shared screen stops feeling live, and 3% loss is where artefacts
 * become obvious on screen content (flat regions smear).
 */
export function gradeSignal(rttMs: number, lossRatio: number, live: boolean): SignalGrade {
  if (!live) return 'dead'
  if (rttMs <= 0 && lossRatio <= 0) return 'good'
  if (rttMs > 250 || lossRatio > 0.05) return 'poor'
  if (rttMs > 120 || lossRatio > 0.015) return 'fair'
  return 'good'
}

export function gradeColor(grade: SignalGrade): string {
  switch (grade) {
    case 'good':
      return 'var(--signal-good)'
    case 'fair':
      return 'var(--signal-fair)'
    case 'poor':
      return 'var(--signal-poor)'
    default:
      return 'var(--signal-dead)'
  }
}

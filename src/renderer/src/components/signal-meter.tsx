import type { JSX } from 'react'

import { formatBitrate, formatLoss, formatMs, gradeColor, gradeSignal } from '../lib/format'
import type { LinkStats } from '../rtc/peer-link'

/**
 * The signature element: a signal rail.
 *
 * Four segments lit like an analogue strength meter, sitting directly under a
 * person rather than hidden in a diagnostics panel. Connection quality is the
 * one number that decides whether watching together works at all, so it is
 * ambient chrome here, not a settings screen.
 *
 * Reads from the same `getStats()` loop TeamSpeak drives through
 * `RTCStatsCollectorCallbackLambda`.
 */

interface SignalMeterProps {
  stats: LinkStats
  live: boolean
  /** `bar` for the rail, `inline` for the stage chrome. */
  variant?: 'bar' | 'inline'
}

const SEGMENTS = 4

function litSegments(grade: ReturnType<typeof gradeSignal>): number {
  switch (grade) {
    case 'good':
      return 4
    case 'fair':
      return 3
    case 'poor':
      return 2
    default:
      return 0
  }
}

export function SignalMeter({ stats, live, variant = 'bar' }: SignalMeterProps): JSX.Element {
  const grade = gradeSignal(stats.rttMs, stats.lossRatio, live)
  const color = gradeColor(grade)
  const lit = litSegments(grade)

  const title = live
    ? [
        `latencia ${formatMs(stats.rttMs)}`,
        `perda ${formatLoss(stats.lossRatio)}`,
        `taxa ${formatBitrate(stats.bitrate)}`,
        stats.relayed ? 'via retransmissor (TURN)' : 'conexao direta'
      ].join(' · ')
    : 'sem conexao'

  return (
    <div className={`tm-signal tm-signal--${variant}`} title={title}>
      <div className="tm-signal__bars" role="img" aria-label={title}>
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <span
            key={index}
            className="tm-signal__seg"
            style={{
              height: `${30 + index * 23}%`,
              background: index < lit ? color : 'var(--signal-dead)',
              opacity: index < lit ? 1 : 0.35
            }}
          />
        ))}
      </div>
      {variant === 'inline' && (
        <span className="tm-signal__read num">
          {formatMs(stats.rttMs)}
          {stats.relayed && <span className="tm-signal__relay" title="via TURN">R</span>}
        </span>
      )}
    </div>
  )
}

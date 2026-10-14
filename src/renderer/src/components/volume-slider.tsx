import type { ChangeEvent, JSX } from 'react'

import { formatVolume } from '../lib/format'
import { IconVolume, IconVolumeOff } from './icons'

/**
 * Per-person volume.
 *
 * Range goes to 200% on purpose: the single most common complaint in a group
 * call is "I can barely hear you", and the honest fix is gain, not asking
 * someone to move their microphone. Above 100% the track turns lilac so it is
 * clear you are boosting rather than merely turning up.
 */

interface VolumeSliderProps {
  volume: number
  muted: boolean
  onVolume: (volume: number) => void
  onToggleMute: () => void
  label?: string
  compact?: boolean
  /** When false the peer is sending no audio; say so instead of pretending. */
  audible?: boolean
}

const MAX = 2

export function VolumeSlider({
  volume,
  muted,
  onVolume,
  onToggleMute,
  label,
  compact = false,
  audible = true
}: VolumeSliderProps): JSX.Element {
  const effective = muted ? 0 : volume
  const percent = (effective / MAX) * 100
  const boosted = !muted && volume > 1

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onVolume(Number(event.target.value))
  }

  if (!audible) {
    return (
      <div className="tm-volume tm-volume--silent" title="Essa pessoa não está mandando áudio">
        <IconVolumeOff size={16} />
        <span className="tm-volume__none label">sem áudio</span>
      </div>
    )
  }

  return (
    <div className={`tm-volume${compact ? ' tm-volume--compact' : ''}`}>
      <button
        type="button"
        className="tm-volume__mute"
        onClick={onToggleMute}
        aria-pressed={muted}
        title={muted ? 'Reativar som' : 'Silenciar'}
      >
        {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
      </button>

      <div className="tm-volume__track">
        <div
          className="tm-volume__fill"
          style={{
            width: `${percent}%`,
            background: boosted ? 'var(--accent)' : 'var(--text-secondary)'
          }}
        />
        {/* 100% reference tick, so "normal" is findable by feel. */}
        <span className="tm-volume__tick" style={{ left: `${(1 / MAX) * 100}%` }} />
        <input
          type="range"
          min={0}
          max={MAX}
          step={0.01}
          value={effective}
          onChange={handleChange}
          aria-label={label ? `Volume de ${label}` : 'Volume'}
          className="tm-volume__input"
        />
      </div>

      {!compact && (
        <span className={`tm-volume__value num${boosted ? ' is-boosted' : ''}`}>
          {formatVolume(effective)}
        </span>
      )}
    </div>
  )
}

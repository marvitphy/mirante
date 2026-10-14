import type { JSX } from 'react'

import type { ScreenProfileName } from '../rtc/sdp'
import {
  IconCamera,
  IconCameraOff,
  IconLeave,
  IconMic,
  IconMicOff,
  IconScreen
} from './icons'
import { UpdateBadge } from './update-badge'

/**
 * The dock: the five things you actually do during a session.
 *
 * Sharing is the primary action and is the only control that carries the lilac
 * accent — colour is a scarce resource here, so it goes to the one button the
 * whole product exists for.
 */

interface ControlDockProps {
  sharing: boolean
  cameraOn: boolean
  micOn: boolean
  profile: ScreenProfileName
  onToggleScreen: () => void
  onToggleCamera: () => void
  onToggleMic: () => void
  onProfile: (profile: ScreenProfileName) => void
  onLeave: () => void
}

const PROFILE_LABELS: Record<ScreenProfileName, { name: string; hint: string }> = {
  crisp: { name: 'Nítido', hint: '30 fps · prioriza resolução, bom pra texto e código' },
  smooth: { name: 'Fluido', hint: '60 fps · prioriza movimento, bom pra jogo e vídeo' },
  thrifty: { name: 'Econômico', hint: '2,5 Mb/s · pra internet apertada ou sala cheia' }
}

export function ControlDock({
  sharing,
  cameraOn,
  micOn,
  profile,
  onToggleScreen,
  onToggleCamera,
  onToggleMic,
  onProfile,
  onLeave
}: ControlDockProps): JSX.Element {
  return (
    <div className="tm-dock">
      <button
        type="button"
        className={`tm-btn tm-btn--primary${sharing ? ' is-on' : ''}`}
        onClick={onToggleScreen}
        title="Transmitir tela (Ctrl+Shift+S)"
      >
        <IconScreen size={16} />
        {sharing ? 'Parar transmissão' : 'Transmitir tela'}
      </button>

      <div className="tm-dock__group">
        <button
          type="button"
          className={`tm-pill${cameraOn ? ' is-on' : ''}`}
          onClick={onToggleCamera}
          aria-pressed={cameraOn}
          title="Câmera (Ctrl+Shift+C)"
        >
          {cameraOn ? <IconCamera size={16} /> : <IconCameraOff size={16} />}
        </button>
        <button
          type="button"
          className={`tm-pill${micOn ? ' is-on' : ''}`}
          onClick={onToggleMic}
          aria-pressed={micOn}
          title="Microfone (Ctrl+Shift+M)"
        >
          {micOn ? <IconMic size={16} /> : <IconMicOff size={16} />}
        </button>
      </div>

      {sharing && (
        <div className="tm-dock__profiles" role="radiogroup" aria-label="Qualidade da transmissão">
          {(Object.keys(PROFILE_LABELS) as ScreenProfileName[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={profile === key}
              className={`tm-seg${profile === key ? ' is-on' : ''}`}
              onClick={() => onProfile(key)}
              title={PROFILE_LABELS[key].hint}
            >
              {PROFILE_LABELS[key].name}
            </button>
          ))}
        </div>
      )}

      <div className="tm-dock__spacer" />

      <UpdateBadge />

      <button type="button" className="tm-btn tm-btn--danger" onClick={onLeave} title="Sair da sala">
        <IconLeave size={16} />
        Sair
      </button>
    </div>
  )
}

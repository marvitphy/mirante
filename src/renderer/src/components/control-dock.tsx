import type { JSX } from 'react'

import type { ScreenProfileName } from '../rtc/sdp'
import {
  IconCamera,
  IconCameraOff,
  IconLeave,
  IconMic,
  IconMicOff,
  IconScreen,
  IconSettings
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
  /** Swap the shared window or screen without stopping the broadcast. */
  onChangeSource: () => void
  onToggleCamera: () => void
  onToggleMic: () => void
  onProfile: (profile: ScreenProfileName) => void
  onLeave: () => void
  onSettings: () => void
  /** `bar` runs along the bottom; `column` stacks inside the sidebar. */
  layout: 'bar' | 'column'
}

const PROFILE_LABELS: Record<ScreenProfileName, { name: string; hint: string }> = {
  // Short enough to fit three across a narrow sidebar without wrapping.
  crisp: { name: 'Nítido', hint: '30 fps · prioriza resolução, bom pra texto e código' },
  smooth: { name: 'Fluido', hint: '60 fps · prioriza movimento, bom pra jogo e vídeo' },
  thrifty: { name: 'Leve', hint: '1 Mb/s · pra internet apertada ou sala cheia' }
}

export function ControlDock({
  sharing,
  cameraOn,
  micOn,
  profile,
  onToggleScreen,
  onChangeSource,
  onToggleCamera,
  onToggleMic,
  onProfile,
  onLeave,
  onSettings,
  layout
}: ControlDockProps): JSX.Element {
  return (
    <div className={`tm-dock tm-dock--${layout}`}>
      <button
        type="button"
        className={`tm-btn tm-btn--primary${sharing ? ' is-on' : ''}`}
        onClick={onToggleScreen}
        title="Transmitir tela (Ctrl+Shift+S)"
      >
        <IconScreen size={16} />
        {sharing ? 'Parar transmissão' : 'Transmitir tela'}
      </button>

      {sharing && (
        // Swapping the source is instant — the slot keeps its transceiver and
        // only the track changes — so there is no reason to make someone stop
        // and start again just to show a different window.
        <button type="button" className="tm-btn" onClick={onChangeSource}>
          Trocar fonte
        </button>
      )}

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

      {/* Settings and Leave sit at opposite ends — the least and the most
          consequential action in the room, as far apart as the row allows.
          The version line goes underneath, where it informs without
          competing. */}
      <div className="tm-dock__foot">
        <button
          type="button"
          className="tm-pill tm-pill--lone"
          onClick={onSettings}
          title="Configurações"
        >
          <IconSettings size={16} />
        </button>

        <button
          type="button"
          className="tm-btn tm-btn--danger"
          onClick={onLeave}
          title="Sair da sala"
        >
          <IconLeave size={16} />
          Sair
        </button>
      </div>

      <UpdateBadge />
    </div>
  )
}

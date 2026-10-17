import { useState, type JSX } from 'react'

import type { ScreenProfileName } from '../rtc/sdp'
import { AppMixer } from './app-mixer'
import {
  IconCamera,
  IconCameraOff,
  IconLeave,
  IconMic,
  IconMicOff,
  IconScreen,
  IconSettings,
  IconSliders
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
  const [mixerOpen, setMixerOpen] = useState(false)

  return (
    <div className={`tm-dock tm-dock--${layout}`}>
      {/* One primary action, and it is the one the product exists for.
          While live it stops being the loud thing — a broadcast already
          announces itself everywhere else — and keeps only a tally dot.
          Filling it red would put an alarm colour on a routine action and
          put it in competition with the tally that actually means "on air". */}
      <button
        type="button"
        className={`tm-dock__primary${sharing ? ' is-live' : ''}`}
        onClick={onToggleScreen}
        title="Transmitir tela (Ctrl+Shift+S)"
      >
        {sharing ? (
          <span className="tm-dock__lamp" aria-hidden="true" />
        ) : (
          <IconScreen size={16} />
        )}
        {sharing ? 'Parar transmissão' : 'Transmitir tela'}
      </button>

      {sharing && (
        // Two tools for the broadcast in progress, side by side and quieter
        // than the action above them. Swapping the source is instant — the
        // slot keeps its transceiver and only the track changes — so there
        // is no reason to stop and start again to show a different window.
        <div className="tm-dock__tools">
          <button type="button" className="tm-dock__tool" onClick={onChangeSource}>
            <IconScreen size={14} />
            Fonte
          </button>
          <div className="tm-dock__mixer">
            <button
              type="button"
              className={`tm-dock__tool${mixerOpen ? ' is-on' : ''}`}
              onClick={() => setMixerOpen((open) => !open)}
              aria-expanded={mixerOpen}
              title="Equilibrar o som de cada aplicativo na transmissão"
            >
              <IconSliders size={14} />
              Som
            </button>
            {mixerOpen && <AppMixer onClose={() => setMixerOpen(false)} />}
          </div>
        </div>
      )}

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

      {/* Your own devices are a different kind of thing from the broadcast
          controls above, so a rule separates them instead of one more equal
          gap. Square and small: they are two icons, and sizing them like
          primary actions was giving the most routine toggles in the app the
          visual weight of the most consequential one. */}
      <div className="tm-dock__devices">
        <button
          type="button"
          className={`tm-dock__device${cameraOn ? ' is-on' : ''}`}
          onClick={onToggleCamera}
          aria-pressed={cameraOn}
          title="Câmera (Ctrl+Shift+C)"
        >
          {cameraOn ? <IconCamera size={16} /> : <IconCameraOff size={16} />}
        </button>
        <button
          type="button"
          className={`tm-dock__device${micOn ? ' is-on' : ''}`}
          onClick={onToggleMic}
          aria-pressed={micOn}
          title="Microfone (Ctrl+Shift+M)"
        >
          {micOn ? <IconMic size={16} /> : <IconMicOff size={16} />}
        </button>
        <span className="tm-dock__devices-fill" />
      </div>

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

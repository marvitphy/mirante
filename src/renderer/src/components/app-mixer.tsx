import { useEffect, useRef, useState, type JSX } from 'react'

import type { MixerChannel } from '../../../main/process-audio'
import { VolumeSlider } from './volume-slider'

/**
 * One fader per application inside your broadcast.
 *
 * Until now the only audio decision was made once, in the source picker, and
 * it was all-or-nothing: this window's sound, or the whole machine's minus
 * the voice apps. That is the wrong shape for the two things people actually
 * say mid-stream — "manda o jogo mas não a música" and "abaixa o jogo que eu
 * vou falar" — because both are about balance and both happen in the middle.
 *
 * The hard half was already built: per-process capture names the
 * applications and keeps a capture open for each. This is the knob.
 *
 * Faders are per APPLICATION, never per process. Chrome moves its audio
 * between processes as tabs come and go, so a fader tied to a pid would
 * reset itself for no reason anybody could see.
 */

export function AppMixer({ onClose }: { onClose: () => void }): JSX.Element {
  const [channels, setChannels] = useState<MixerChannel[]>([])
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const api = window.mirante.mixer
    if (!api) return
    void api
      .channels()
      .then(setChannels)
      .catch(() => setChannels([]))
    // Applications come and go on their own while the broadcast runs.
    return api.onChannels(setChannels)
  }, [])

  /**
   * Closes on a click elsewhere or on Escape — never on the pointer leaving.
   *
   * Leaving was the first attempt and it made the panel impossible to use:
   * the cursor only has to clip a corner on its way to a fader for the whole
   * thing to vanish, and the faders are exactly what it is in the way of.
   */
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      const target = event.target as Node
      // The button that opened this sits outside the panel; let it toggle.
      if (panel.contains(target)) return
      if ((target as HTMLElement).closest?.('.tm-dock__mixer')) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const set = (executable: string, gain: number): void => {
    // Paint immediately, reconcile with what the mixer reports. A fader that
    // waits for a round trip feels broken even when it is not.
    setChannels((current) =>
      current.map((channel) =>
        channel.executable === executable ? { ...channel, gain } : channel
      )
    )
    void window.mirante.mixer.setGain(executable, gain).then(setChannels)
  }

  return (
    <div className="tm-mixer" ref={panelRef} role="group" aria-label="Som da transmissão">
      <div className="tm-mixer__head">
        <span className="label">Som da transmissão</span>
        <span className="tm-mixer__hint label">só pra quem assiste</span>
      </div>

      {channels.length === 0 ? (
        <p className="tm-mixer__empty">
          Nada tocando agora. Os aplicativos aparecem aqui sozinhos assim que
          fizerem som.
        </p>
      ) : (
        channels.map((channel) => (
          <div className="tm-mixer__row" key={channel.executable}>
            <span className="tm-mixer__name" title={channel.executable}>
              {channel.displayName}
            </span>
            {/* The app's own slider, not a second one: it already carries the
                boost colour above 100% and the scroll-to-adjust gesture. */}
            <VolumeSlider
              volume={channel.gain}
              muted={channel.gain === 0}
              onVolume={(gain) => set(channel.executable, gain)}
              onToggleMute={() => set(channel.executable, channel.gain === 0 ? 1 : 0)}
              label={channel.displayName}
            />
          </div>
        ))
      )}
    </div>
  )
}

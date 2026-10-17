import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react'

import {
  activeBackground,
  deviceLabel,
  getCustomBackground,
  getSettings,
  listDevices,
  setCustomBackground,
  updateSettings,
  useCustomBackground,
  useSettings
} from '../lib/settings'
import { CameraFeed, encodeBackground, type SelfView } from '../rtc/camera-background'
import { IconClose, IconImage } from './icons'

/**
 * Pick a camera, the first time.
 *
 * Shown only when there is an actual choice to make: one camera and we just
 * use it. With two or more, a list of "Câmera 1 / Câmera 2" is a guess, so
 * the chosen one previews live — you point at the list until you see your
 * own face, which is the only reliable way to tell a laptop lid camera from
 * a capture card.
 *
 * The answer is remembered, so this appears once and then never again unless
 * someone goes looking for it in settings.
 *
 * It is also where the background is chosen, for the same reason the camera
 * is: you judge a background by seeing yourself in front of it. The preview
 * runs through the same feed as the real camera, so what you see here is
 * what everyone else gets.
 */

interface CameraPickerProps {
  onConfirm: (deviceId: string) => void
  onCancel: () => void
}

export function CameraPicker({ onConfirm, onCancel }: CameraPickerProps): JSX.Element {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  /**
   * The row the pointer is over, previewed without committing to it.
   *
   * The reason the list needed this: on a machine with virtual cameras the
   * names are "Iriun Webcam", "Iriun Webcam #2", "#3", "#4". Nobody knows
   * which is which, including us — the label is everything the browser
   * gives. Only the picture answers it, and clicking each one in turn to
   * find out is a worse version of the same question.
   *
   * One camera is opened at a time, never all of them: some drivers refuse
   * concurrent access, and a grid of live previews would be exactly the
   * thing that breaks on the setups that need this most.
   */
  const [hovered, setHovered] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<SelfView | null>(null)
  /** MediaPipe is loading. The first time takes a moment; say so. */
  const [applying, setApplying] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const feedRef = useRef<CameraFeed | null>(null)

  const settings = useSettings()
  const picture = useCustomBackground()
  const background = activeBackground(settings, picture)

  useEffect(() => {
    void listDevices().then((devices) => {
      setCameras(devices.cameras)
      setSelected((current) => {
        if (current) return current
        // Reopen on the camera in use, not on whatever the system happens
        // to list first. Coming back to this sheet to change camera and
        // finding a different one already highlighted reads as the app
        // having silently switched it.
        const saved = getSettings().cameraId
        const stillThere = devices.cameras.some((c) => c.deviceId === saved)
        return stillThere ? saved : (devices.cameras[0]?.deviceId ?? '')
      })
    })
  }, [])

  // Live preview of whichever entry is highlighted. Always mirrored here: you
  // are looking at yourself, and a mirror is what people expect of their own
  // image. With a background only you are flipped, never the picture.
  const previewing = hovered ?? selected

  useEffect(() => {
    if (!previewing) return
    let cancelled = false

    void (async () => {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: previewing }, width: { ideal: 1280 } }
        })
      } catch {
        if (!cancelled) setError('Essa câmera não respondeu. Pode estar em uso por outro app.')
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      const feed = new CameraFeed(stream, true)
      feedRef.current?.close()
      feedRef.current = feed
      setView(feed.selfView)
      setError(null)
      // Labels only populate once permission has been granted, so refresh
      // the list the moment we have it.
      void listDevices().then((devices) => setCameras(devices.cameras))

      // The background follows a moment later, so the camera answering is
      // never held up by MediaPipe loading.
      setApplying(activeBackground(getSettings(), getCustomBackground()) !== null)
      try {
        await feed.setBackground(activeBackground(getSettings(), getCustomBackground()))
      } catch {
        setNotice('Não consegui aplicar o fundo nesta máquina.')
      }
      if (feedRef.current === feed) {
        setView(feed.selfView)
        feed.releaseRetired()
        setApplying(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [previewing])

  // Background chosen or switched off: applied to the running preview.
  useEffect(() => {
    const feed = feedRef.current
    if (!feed) return
    setApplying(background !== null && !feed.backgroundOn)
    void feed
      .setBackground(background)
      .catch(() => setNotice('Não consegui aplicar o fundo nesta máquina.'))
      .finally(() => {
        if (feedRef.current !== feed) return
        // Nothing here is published, so the preview is the only thing that
        // was showing the old picture: swap it, then let the old one go.
        setView(feed.selfView)
        feed.releaseRetired()
        setApplying(false)
      })
  }, [background])

  useEffect(() => {
    const video = videoRef.current
    if (!video || video.srcObject === (view?.stream ?? null)) return
    video.srcObject = view?.stream ?? null
    if (view) void video.play().catch(() => undefined)
  }, [view, error])

  // Stop the preview on the way out, so the camera light goes off.
  useEffect(() => {
    return () => {
      feedRef.current?.close()
      feedRef.current = null
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
      if (event.key === 'Enter' && selected) commit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function commit(): void {
    if (!selected) return
    updateSettings({ cameraId: selected })
    onConfirm(selected)
  }

  function choosePicture(): void {
    fileRef.current?.click()
  }

  async function onPicture(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget
    const file = input.files?.[0]
    // Cleared so picking the same file again still counts as a change.
    input.value = ''
    if (!file) return

    let encoded: string
    try {
      encoded = await encodeBackground(file)
    } catch {
      setNotice('Não consegui abrir essa imagem. Tente outra.')
      return
    }
    if (!setCustomBackground(encoded)) {
      setNotice('Essa imagem não coube no espaço do app. Tente uma menor.')
      return
    }
    setNotice(null)
    updateSettings({ cameraBackground: true })
  }

  return (
    <div className="tm-scrim" onMouseDown={onCancel}>
      <div
        className="tm-sheet tm-sheet--camera"
        role="dialog"
        aria-modal="true"
        aria-label="Escolher câmera"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tm-sheet__head">
          <h2 className="label">Qual câmera</h2>
          <button type="button" className="tm-iconbtn" onClick={onCancel} title="Fechar · Esc">
            <IconClose size={16} />
          </button>
        </header>

        <div className="tm-sheet__scroll">
          <div className="tm-campick">
          {/* A panel with a header, so the column has a shape. Six short
              rows floating as loose text left the bottom of the dialog
              empty and made the two halves look merely adjacent. */}
          <div className="tm-campick__panel">
          <div className="tm-campick__panelhead label">Câmera</div>
          <div
            className="tm-campick__list"
            role="radiogroup"
            aria-label="Câmeras"
            onMouseLeave={() => setHovered(null)}
          >
            {cameras.map((camera, index) => (
              <button
                key={camera.deviceId}
                type="button"
                role="radio"
                aria-checked={selected === camera.deviceId}
                className={`tm-campick__item${selected === camera.deviceId ? ' is-on' : ''}${
                  hovered === camera.deviceId && selected !== camera.deviceId ? ' is-peeking' : ''
                }`}
                onClick={() => setSelected(camera.deviceId)}
                onDoubleClick={commit}
                onMouseEnter={() => setHovered(camera.deviceId)}
                onFocus={() => setHovered(camera.deviceId)}
                onBlur={() => setHovered(null)}
              >
                <span className="tm-campick__mark" aria-hidden="true" />
                <span className="tm-campick__label">
                  {deviceLabel(camera, index, 'Câmera')}
                </span>
              </button>
            ))}
            {cameras.length === 0 && (
              <p className="tm-campick__empty">
                Nenhuma câmera encontrada. Se você usa o celular como webcam,
                abra o programa dela primeiro.
              </p>
            )}
          </div>
          </div>

          <div className="tm-campick__side">
            <div className="tm-campick__preview">
              {error ? (
                <p className="tm-campick__error">{error}</p>
              ) : (
                <>
                  <video
                    ref={videoRef}
                    className={view?.flip === false ? undefined : 'is-mirrored'}
                    autoPlay
                    playsInline
                    muted
                  />
                  {/* Which one this is. With four devices called almost the
                      same thing, a preview with no caption only moves the
                      confusion. */}
                  <span className="tm-campick__tag">
                    <span className="tm-campick__lamp" aria-hidden="true" />
                    {cameras.find((c) => c.deviceId === previewing)
                      ? deviceLabel(
                          cameras.find((c) => c.deviceId === previewing) as MediaDeviceInfo,
                          cameras.findIndex((c) => c.deviceId === previewing),
                          'Câmera'
                        )
                      : 'procurando…'}
                    {hovered && hovered !== selected && (
                      <em className="tm-campick__peek">prévia</em>
                    )}
                  </span>
                </>
              )}
            </div>

            <section className="tm-campick__bg" aria-label="Fundo">
              {/* The same label-and-rule the settings sheet uses for its
                  groups. Floating the word on its own left it looking like
                  a stray caption rather than the head of a section. */}
              <div className="tm-campick__bghead">
                <span className="label">Fundo</span>
                <span className="tm-campick__bgrule" />
                {applying && <span className="tm-campick__busy label">aplicando…</span>}
                {picture && (
                  <button
                    type="button"
                    className="tm-btn tm-campick__swap"
                    onClick={choosePicture}
                  >
                    Trocar imagem
                  </button>
                )}
              </div>

              <div className="tm-campick__bgopts" role="radiogroup" aria-label="Fundo">
                <button
                  type="button"
                  role="radio"
                  aria-checked={background === null}
                  className={`tm-bgopt${background === null ? ' is-on' : ''}`}
                  onClick={() => updateSettings({ cameraBackground: false })}
                >
                  <span className="tm-bgopt__swatch tm-bgopt__swatch--none" aria-hidden="true" />
                  <span className="tm-bgopt__foot">
                    <span className="tm-aopt__dot" aria-hidden="true" />
                    Nenhum
                  </span>
                </button>

                {picture ? (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={background !== null}
                    className={`tm-bgopt${background !== null ? ' is-on' : ''}`}
                    onClick={() => updateSettings({ cameraBackground: true })}
                  >
                    <img className="tm-bgopt__swatch" src={picture} alt="" />
                    <span className="tm-bgopt__foot">
                      <span className="tm-aopt__dot" aria-hidden="true" />
                      Minha imagem
                    </span>
                  </button>
                ) : (
                  <button type="button" className="tm-bgopt" onClick={choosePicture}>
                    <span className="tm-bgopt__swatch tm-bgopt__swatch--add" aria-hidden="true">
                      <IconImage size={20} />
                    </span>
                    <span className="tm-bgopt__foot">Escolher imagem</span>
                  </button>
                )}
              </div>

              {notice && (
                <p className="tm-campick__notice" role="alert">
                  {notice}
                </p>
              )}

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => void onPicture(event)}
              />
            </section>
          </div>
          </div>
        </div>

        <footer className="tm-sheet__foot">
          {/* Sentence case, not the tracked uppercase used for labels: this
              is a reassurance to be read once, and shouting it makes the
              footer compete with the choice above it. */}
          <span className="tm-campick__note">
            Passe o mouse pela lista pra ver cada câmera. Dá pra trocar depois.
          </span>
          <div className="tm-sheet__actions">
            <button type="button" className="tm-btn" onClick={onCancel}>
              Cancelar
            </button>
            <button
              type="button"
              className="tm-btn tm-btn--primary"
              onClick={commit}
              disabled={!selected}
            >
              Usar esta
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

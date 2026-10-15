import { useEffect, useRef, useState, type JSX } from 'react'

import { deviceLabel, listDevices, updateSettings } from '../lib/settings'
import { IconClose } from './icons'

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
 */

interface CameraPickerProps {
  onConfirm: (deviceId: string) => void
  onCancel: () => void
}

export function CameraPicker({ onConfirm, onCancel }: CameraPickerProps): JSX.Element {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewRef = useRef<MediaStream | null>(null)

  useEffect(() => {
    void listDevices().then((devices) => {
      setCameras(devices.cameras)
      setSelected((current) => current || devices.cameras[0]?.deviceId || '')
    })
  }, [])

  // Live preview of whichever entry is highlighted.
  useEffect(() => {
    if (!selected) return
    let cancelled = false

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selected }, width: { ideal: 1280 } }
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        previewRef.current?.getTracks().forEach((t) => t.stop())
        previewRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => undefined)
        }
        setError(null)
        // Labels only populate once permission has been granted, so refresh
        // the list the moment we have it.
        void listDevices().then((devices) => setCameras(devices.cameras))
      } catch {
        if (!cancelled) setError('Essa câmera não respondeu. Pode estar em uso por outro app.')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selected])

  // Stop the preview on the way out, so the camera light goes off.
  useEffect(() => {
    return () => {
      previewRef.current?.getTracks().forEach((t) => t.stop())
      previewRef.current = null
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
          <div className="tm-campick__list" role="radiogroup" aria-label="Câmeras">
            {cameras.map((camera, index) => (
              <button
                key={camera.deviceId}
                type="button"
                role="radio"
                aria-checked={selected === camera.deviceId}
                className={`tm-campick__item${selected === camera.deviceId ? ' is-on' : ''}`}
                onClick={() => setSelected(camera.deviceId)}
                onDoubleClick={commit}
              >
                <span className="tm-aopt__dot" aria-hidden="true" />
                <span>{deviceLabel(camera, index, 'Câmera')}</span>
              </button>
            ))}
            {cameras.length === 0 && (
              <p className="tm-campick__empty label">nenhuma câmera encontrada</p>
            )}
          </div>

          <div className="tm-campick__preview">
            {error ? (
              <p className="tm-campick__error">{error}</p>
            ) : (
              <video ref={videoRef} autoPlay playsInline muted />
            )}
            </div>
          </div>
        </div>

        <footer className="tm-sheet__foot">
          <span className="tm-sheet__hint label">dá pra trocar depois em configurações</span>
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

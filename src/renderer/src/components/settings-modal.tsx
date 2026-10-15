import { useEffect, useState, type JSX, type ReactNode } from 'react'

import {
  deviceLabel,
  listDevices,
  updateSettings,
  useSettings,
  type DeviceList
} from '../lib/settings'
import { formatVolume } from '../lib/format'
import { SCREEN_PROFILES, type ScreenProfileName } from '../rtc/sdp'
import { IconClose } from './icons'

/**
 * Settings.
 *
 * Grouped by the question each answers rather than by the subsystem that
 * implements it: "what does everyone see and hear of me", "what goes out
 * when I share", "what reaches my ears", "where does this connect".
 *
 * Every control writes through immediately. There is no Save button, because
 * a Save button on a preferences panel is a chance to lose work and nothing
 * else.
 */

interface SettingsModalProps {
  version: string
  onClose: () => void
}

const PROFILE_LABELS: Record<ScreenProfileName, string> = {
  crisp: 'Nítido',
  smooth: 'Fluido',
  thrifty: 'Econômico'
}

const PROFILE_HINTS: Record<ScreenProfileName, string> = {
  crisp: 'Prioriza resolução. Bom pra texto e código.',
  smooth: 'Prioriza movimento. Bom pra jogo e vídeo.',
  thrifty: 'Pra internet apertada ou sala cheia.'
}

export function SettingsModal({ version, onClose }: SettingsModalProps): JSX.Element {
  const settings = useSettings()
  const [devices, setDevices] = useState<DeviceList>({
    cameras: [],
    microphones: [],
    speakers: []
  })

  useEffect(() => {
    void listDevices().then(setDevices)
    // Plugging in a headset while this is open should update the lists.
    const onChange = (): void => void listDevices().then(setDevices)
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="tm-scrim" onMouseDown={onClose}>
      <div
        className="tm-sheet tm-sheet--settings"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tm-sheet__head">
          <h2 className="label">Configurações</h2>
          <button type="button" className="tm-iconbtn" onClick={onClose} title="Fechar · Esc">
            <IconClose size={16} />
          </button>
        </header>

        <div className="tm-sheet__scroll">
          <Group title="Dispositivos">
            <Row label="Câmera" hint="Usada quando você liga a câmera.">
              <Picker
                value={settings.cameraId}
                onChange={(cameraId) => updateSettings({ cameraId })}
                options={devices.cameras.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Câmera')
                }))}
              />
            </Row>

            <Row label="Microfone" hint="Sua voz. Não tem a ver com o som da transmissão.">
              <Picker
                value={settings.microphoneId}
                onChange={(microphoneId) => updateSettings({ microphoneId })}
                options={devices.microphones.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Microfone')
                }))}
              />
            </Row>

            <Row label="Saída de som" hint="Onde você escuta todo mundo.">
              <Picker
                value={settings.speakerId}
                onChange={(speakerId) => updateSettings({ speakerId })}
                options={devices.speakers.map((d, i) => ({
                  value: d.deviceId,
                  label: deviceLabel(d, i, 'Saída')
                }))}
              />
            </Row>

            <Row label="Espelhar sua câmera" hint="Só na sua prévia. Os outros veem normal.">
              <Toggle
                checked={settings.mirrorSelf}
                onChange={(mirrorSelf) => updateSettings({ mirrorSelf })}
              />
            </Row>
          </Group>

          <Group title="Transmissão">
            <Row label="Qualidade padrão" hint={PROFILE_HINTS[settings.defaultProfile]}>
              <div className="tm-segrow">
                {(Object.keys(PROFILE_LABELS) as ScreenProfileName[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`tm-seg${settings.defaultProfile === key ? ' is-on' : ''}`}
                    onClick={() => updateSettings({ defaultProfile: key })}
                  >
                    {PROFILE_LABELS[key]}
                  </button>
                ))}
              </div>
            </Row>

            <Row
              label="Teto de banda"
              hint="Por espectador. Numa sala cheia isso é dividido automaticamente."
            >
              <span className="tm-setting__readout num">
                {(SCREEN_PROFILES[settings.defaultProfile].maxBitrate / 1_000_000).toFixed(1)} Mb/s
                {' · '}
                {SCREEN_PROFILES[settings.defaultProfile].maxFramerate} fps
              </span>
            </Row>

            <Row label="Começar com som" hint="O que vem marcado ao abrir o seletor de fonte.">
              <Toggle
                checked={settings.shareWithSound}
                onChange={(shareWithSound) => updateSettings({ shareWithSound })}
              />
            </Row>
          </Group>

          <Group title="O que você escuta">
            <Row label="Volume geral" hint="Afeta todo mundo de uma vez.">
              <div className="tm-setting__slider">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.masterVolume}
                  onChange={(e) => updateSettings({ masterVolume: Number(e.target.value) })}
                />
                <span className="num">{formatVolume(settings.masterVolume)}</span>
              </div>
            </Row>

            <Row
              label="Sons da sala"
              hint="Entrada, saída e início de transmissão."
            >
              <Toggle
                checked={settings.roomSounds}
                onChange={(roomSounds) => updateSettings({ roomSounds })}
              />
            </Row>
          </Group>

          <Group title="Conexão">
            <Row
              label="Servidor"
              hint="Só coordena a conexão. A imagem vai direto de um pro outro."
            >
              <input
                className="tm-input tm-input--inline num selectable"
                value={settings.server}
                placeholder="padrão do aplicativo"
                onChange={(e) => updateSettings({ server: e.target.value })}
              />
            </Row>
          </Group>

          <Group title="Sobre">
            <Row label="Versão">
              <span className="tm-setting__readout num">v{version}</span>
            </Row>
            <Row label="Registro" hint="Mande este arquivo quando algo der errado.">
              <span className="tm-setting__readout num selectable">
                %APPDATA%\tvmirante\logs\mirante.log
              </span>
            </Row>
          </Group>
        </div>

        <footer className="tm-sheet__foot">
          <span className="tm-sheet__hint label">
            tudo é salvo na hora · dispositivos valem a partir da próxima vez que ligar
          </span>
          <button type="button" className="tm-btn tm-btn--primary" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="tm-setgroup">
      <div className="tm-group__head">
        <span className="label">{title}</span>
        <span className="tm-group__rule" />
      </div>
      {children}
    </section>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="tm-setrow">
      <div className="tm-setrow__text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="tm-setrow__control">{children}</div>
    </div>
  )
}

function Picker({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}): JSX.Element {
  return (
    <select
      className="tm-select"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Padrão do sistema</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({
  checked,
  onChange
}: {
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <label className="tm-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="tm-toggle__box" aria-hidden="true" />
    </label>
  )
}

import { useEffect, useMemo, useState, type JSX } from 'react'

import type { CaptureSource } from '../../../main/capture'
import type { AudioApp, AudioCapability } from '../../../main/process-audio'
import { IconClose } from './icons'

/**
 * Source picker — and the anti-echo control.
 *
 * Two structural decisions:
 *
 * 1. TABS, not stacked sections. Screens and windows used to render as two
 *    grids one above the other, which in a non-maximised window pushed the
 *    audio controls and the footer off-screen. One grid at a time keeps the
 *    sheet short enough to fit any window the app allows.
 *
 * 2. The audio half is the whole reason this exists instead of Chromium's
 *    built-in picker. System-wide loopback captures everything leaving your
 *    speakers, including your friends' voices coming back out of this very
 *    app. That is the echo. Binding capture to one process tree makes it
 *    structurally impossible. Both TeamSpeak and Discord ship this in native
 *    code — teardown §A.3.
 */

interface SourcePickerProps {
  sources: CaptureSource[]
  onConfirm: (sourceId: string, withSound: boolean) => void
  onCancel: () => void
}

type TabId = 'screens' | 'windows'

export function SourcePicker({ sources, onConfirm, onCancel }: SourcePickerProps): JSX.Element {
  const screens = useMemo(() => sources.filter((s) => s.kind === 'screen'), [sources])
  const windows = useMemo(() => sources.filter((s) => s.kind === 'window'), [sources])

  const [tab, setTab] = useState<TabId>(screens.length > 0 ? 'screens' : 'windows')
  const [selected, setSelected] = useState<string | null>(
    (screens[0] ?? windows[0])?.id ?? null
  )
  const [capability, setCapability] = useState<AudioCapability | null>(null)
  const [apps, setApps] = useState<AudioApp[]>([])
  /** Sending sound is what people expect, so it starts on. */
  const [sendAudio, setSendAudio] = useState(true)

  const visible = tab === 'screens' ? screens : windows
  const selectedSource = sources.find((s) => s.id === selected) ?? null

  useEffect(() => {
    void window.mirante.audio.capability().then(setCapability)
  }, [])

  // Rank the app list against the chosen window's title, so sharing a game
  // pre-selects that game's audio.
  useEffect(() => {
    if (!capability?.supported) return
    // Only to show what will be included; nothing here is a choice.
    void window.mirante.audio.listApps().then(setApps)
  }, [capability?.supported, selectedSource?.name])

  function confirm(): void {
    if (selected) onConfirm(selected, sendAudio)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
      if (event.key === 'Enter' && selected) {
        event.preventDefault()
        confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="tm-scrim" onMouseDown={onCancel}>
      <div
        className="tm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Escolher o que transmitir"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="tm-sheet__head">
          <h2 className="label">Fonte de captura</h2>
          <button type="button" className="tm-iconbtn" onClick={onCancel} title="Fechar · Esc">
            <IconClose size={16} />
          </button>
        </header>

        <nav className="tm-tabs" role="tablist" aria-label="Tipo de fonte">
          <Tab
            id="screens"
            active={tab}
            count={screens.length}
            label="Telas"
            onSelect={setTab}
          />
          <Tab
            id="windows"
            active={tab}
            count={windows.length}
            label="Janelas"
            onSelect={setTab}
          />
          <span className="tm-tabs__fill" />
        </nav>

        <div className="tm-sheet__scroll" role="tabpanel">
          {visible.length > 0 ? (
            <div className="tm-grid">
              {visible.map((source) => (
                <SourceTile
                  key={source.id}
                  source={source}
                  selected={selected === source.id}
                  onSelect={() => setSelected(source.id)}
                  onCommit={confirm}
                />
              ))}
            </div>
          ) : (
            <p className="tm-sheet__empty">
              {tab === 'screens' ? 'Nenhuma tela detectada.' : 'Nenhuma janela aberta.'}
            </p>
          )}
        </div>

        <section className="tm-audio">
          <label className="tm-switch">
            <input
              type="checkbox"
              checked={sendAudio}
              onChange={(event) => setSendAudio(event.target.checked)}
            />
            <span className="tm-switch__text">
              <b>Transmitir com som</b>
              <span>{soundHint(selectedSource, capability?.supported === true, apps)}</span>
            </span>
          </label>

          {sendAudio && capability?.supported && selectedSource?.kind === 'screen' && (
            <p className="tm-audio__out">
              <span className="label">fora</span>
              Discord · TeamSpeak · Mirante · Teams · Zoom
            </p>
          )}
        </section>

        <footer className="tm-sheet__foot">
          <span className="tm-sheet__hint label">
            {selectedSource ? selectedSource.name : 'nada selecionado'}
          </span>
          <div className="tm-sheet__actions">
            <button type="button" className="tm-btn" onClick={onCancel}>
              Cancelar
            </button>
            <button
              type="button"
              className="tm-btn tm-btn--primary"
              onClick={confirm}
              disabled={!selected}
            >
              Transmitir
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function Tab({
  id,
  active,
  count,
  label,
  onSelect
}: {
  id: TabId
  active: TabId
  count: number
  label: string
  onSelect: (id: TabId) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active === id}
      className={`tm-tab${active === id ? ' is-on' : ''}`}
      onClick={() => onSelect(id)}
    >
      {label}
      <span className="tm-tab__count">{String(count).padStart(2, '0')}</span>
    </button>
  )
}

function SourceTile({
  source,
  selected,
  onSelect,
  onCommit
}: {
  source: CaptureSource
  selected: boolean
  onSelect: () => void
  onCommit: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`tm-src${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      onDoubleClick={onCommit}
      title={source.name}
    >
      <span className="tm-src__shot">
        {source.thumbnail ? (
          <img src={source.thumbnail} alt="" draggable={false} />
        ) : (
          <span className="tm-src__void" aria-hidden="true" />
        )}
        <span className="tm-src__ticks" aria-hidden="true" />
      </span>
      <span className="tm-src__meta">
        {source.appIcon ? (
          <img className="tm-src__icon" src={source.appIcon} alt="" draggable={false} />
        ) : (
          <span className="tm-src__icon tm-src__icon--none" aria-hidden="true" />
        )}
        {/* Own box with a zero flex-basis, or a long window title refuses to
            shrink and collides with the tile beside it. */}
        <span className="tm-src__label">{source.name}</span>
      </span>
    </button>
  )
}

/** "chrome.exe" reads as noise; "chrome" reads as a thing you recognise. */
function shortName(executable: string): string {
  return executable.replace(/\.exe$/i, '')
}

/**
 * Say what will actually be sent. Nobody has to choose — it follows from the
 * source — but they should still be able to see it before committing.
 */
function soundHint(
  source: CaptureSource | null,
  perApp: boolean,
  apps: AudioApp[]
): string {
  if (!source) return 'Escolha uma tela ou janela.'
  if (!perApp) {
    return 'Som do sistema inteiro — pode causar eco se você estiver em chamada.'
  }
  if (source.kind === 'window') return `Só o som de ${source.name}.`
  const playing = apps.map((a) => shortName(a.executable)).join(' · ')
  return playing
    ? `Tudo que está tocando — ${playing} — menos a voz dos seus amigos.`
    : 'Tudo que estiver tocando, menos a voz dos seus amigos.'
}

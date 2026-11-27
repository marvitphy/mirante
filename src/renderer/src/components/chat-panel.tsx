import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'

import type { ChatEntry } from '../rtc/mesh-session'
import { IconClose } from './icons'

/**
 * A scratchpad for the room — not a transcript, not an inbox.
 *
 * Non-modal on purpose: reading what someone wrote is a glance, and a scrim
 * over the picture would turn that glance into an interruption. The log grows
 * downwards and sticks to the newest line; nobody opens chat to reread the
 * beginning.
 */
interface ChatPanelProps {
  messages: ChatEntry[]
  onSend: (text: string) => boolean
  onClose: () => void
}

const HORA = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit'
})

export function ChatPanel({ messages, onSend, onClose }: ChatPanelProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const expected = useRef(0)
  const ackTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (ackTimer.current !== null) window.clearTimeout(ackTimer.current)
  }, [])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
    // The server echoes every message, including to its sender. If that
    // echo never comes, the server is too old to know the chat verb; say so
    // instead of clearing the input and leaving the person guessing.
    if (expected.current > 0 && messages.length >= expected.current) {
      expected.current = 0
      if (ackTimer.current !== null) {
        window.clearTimeout(ackTimer.current)
        ackTimer.current = null
      }
      setHint(null)
    }
  }, [messages])

  // Same contract as the mixer: a click elsewhere closes, but moving the
  // cursor across a corner on the way to the input must not. The button that
  // opened this lives outside the panel and is allowed to toggle it shut.
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      const target = event.target as Node
      if (panel.contains(target)) return
      if ((target as HTMLElement).closest?.('.tm-dock__chat')) return
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

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!draft.trim()) return
    const sent = onSend(draft)
    if (!sent) {
      setHint('Sem conexão com a sala. Tente de novo.')
      return
    }
    expected.current = messages.length + 1
    setDraft('')
    setHint(null)
    if (ackTimer.current !== null) window.clearTimeout(ackTimer.current)
    ackTimer.current = window.setTimeout(() => {
      ackTimer.current = null
      if (expected.current === 0) return
      expected.current = 0
      setHint('Este servidor não suporta chat. Use o servidor local ou atualize o servidor.')
    }, 1_500)
  }

  return (
    <div className="tm-chat" ref={panelRef} role="group" aria-label="Chat da sala">
      <div className="tm-chat__head">
        <span className="label">Chat da sala</span>
        <button type="button" className="tm-iconbtn" onClick={onClose} title="Fechar · Esc">
          <IconClose size={14} />
        </button>
      </div>

      <div className="tm-chat__log selectable" role="log" aria-live="polite" ref={logRef}>
        {messages.length === 0 ? (
          <p className="tm-chat__empty">
            Ninguém escreveu ainda. Diga oi, mande um link, combine o que assistir.
          </p>
        ) : (
          messages.map((entry, index) => (
            <div className="tm-chat__row" key={`${entry.from}-${entry.at}-${index}`}>
              <span className="tm-chat__meta">
                <span
                  className="tm-chat__who"
                  style={{ color: `hsl(${entry.hue} 70% 80%)` }}
                >
                  {entry.mine ? 'você' : entry.name}
                </span>
                <span className="tm-chat__time num">{HORA.format(entry.at)}</span>
              </span>
              <span className="tm-chat__text">{entry.text}</span>
            </div>
          ))
        )}
      </div>

      {hint && <p className="tm-chat__hint">{hint}</p>}

      <form className="tm-chat__form" onSubmit={submit}>
        <input
          className="tm-chat__input selectable"
          value={draft}
          maxLength={500}
          autoFocus
          placeholder="Mensagem…"
          aria-label="Mensagem para a sala"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="submit"
          className="tm-btn tm-chat__send"
          disabled={!draft.trim()}
        >
          Enviar
        </button>
      </form>
    </div>
  )
}

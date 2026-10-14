import { useState, type FormEvent, type JSX } from 'react'

import { Logo } from './logo'

/**
 * Join screen.
 *
 * Split and asymmetric rather than a card in the middle of the viewport. The
 * left half is an identity field — the mark at size, the promise in one line,
 * and the technical plate along the bottom like labelling silkscreened onto
 * equipment. The right half is the only thing you have to touch.
 *
 * One real decision lives here: which room. Everything else has a default,
 * because the fastest path from "want to show my friends this" to "they can
 * see it" is the product.
 */

interface JoinScreenProps {
  defaultName: string
  defaultRoom: string
  defaultServer: string
  error: string | null
  connecting: boolean
  onJoin: (details: { name: string; room: string; server: string }) => void
}

export function JoinScreen({
  defaultName,
  defaultRoom,
  defaultServer,
  error,
  connecting,
  onJoin
}: JoinScreenProps): JSX.Element {
  const [name, setName] = useState(defaultName)
  const [room, setRoom] = useState(defaultRoom)
  const [server, setServer] = useState(defaultServer)
  const [advanced, setAdvanced] = useState(false)

  const ready = name.trim().length > 0 && room.trim().length > 0

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!ready) return
    onJoin({ name: name.trim(), room: room.trim(), server: server.trim() })
  }

  return (
    <div className="tm-join">
      <section className="tm-join__stage">
        <div className="tm-wordmark">
          <Logo size={52} className="tm-wordmark__mark" />
          <h1 className="tm-wordmark__type">MIRANTE</h1>
        </div>

        <p className="tm-join__tagline">
          Sobe no mirante, aponta a tela e assiste junto. O vídeo vai direto da sua
          máquina pra dos seus amigos.
        </p>

        <div className="tm-join__plate">
          <Spec label="transporte" value="WebRTC · mesh P2P" />
          <Spec label="codecs" value="AV1 · VP9 · H.264" />
          <Spec label="áudio" value="Opus 48 kHz · 10 ms" />
        </div>
      </section>

      <form className="tm-join__form" onSubmit={submit}>
        <header className="tm-join__formhead">
          <span className="label">Identificação</span>
          <h2>Entrar numa sala</h2>
        </header>

        <label className="tm-field">
          <span className="label">Seu nome</span>
          <input
            className="tm-input selectable"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={32}
            autoFocus
            placeholder="como te chamam"
          />
        </label>

        <label className="tm-field">
          <span className="label">Sala</span>
          <input
            className="tm-input selectable"
            value={room}
            onChange={(event) => setRoom(event.target.value)}
            maxLength={64}
            placeholder="o nome que vocês combinaram"
          />
          <span className="tm-field__hint">
            Quem digitar o mesmo nome cai na mesma sala. Sem cadastro, sem convite.
          </span>
        </label>

        {advanced ? (
          <label className="tm-field">
            <span className="label">Servidor de sinalização</span>
            <input
              className="tm-input selectable num"
              value={server}
              onChange={(event) => setServer(event.target.value)}
              placeholder="ws://localhost:8787"
            />
            <span className="tm-field__hint">
              Só coordena a conexão. A imagem nunca passa por ele.
            </span>
          </label>
        ) : (
          <button type="button" className="tm-link" onClick={() => setAdvanced(true)}>
            Outro servidor
          </button>
        )}

        <div className="tm-join__grow" />

        {error && <p className="tm-join__error">{error}</p>}

        <button
          type="submit"
          className="tm-btn tm-btn--primary tm-btn--block"
          disabled={connecting || !ready}
        >
          {connecting ? 'Entrando' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}

function Spec({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="tm-join__spec">
      <span className="label">{label}</span>
      <b>{value}</b>
    </div>
  )
}

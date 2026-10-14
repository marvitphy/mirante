import { useEffect, useState, type JSX } from 'react'

import type { SignalingStatus } from '../rtc/signaling'
import { IconClose, IconMaximize, IconMinimize, IconRestore } from './icons'
import { Logo } from './logo'

/**
 * Custom title bar.
 *
 * Frameless window, so this is both the drag handle and the room's status
 * line. The connection state lives here permanently rather than appearing as a
 * toast — in a live app, "am I still connected" is a standing question, not an
 * event.
 */

interface TitleBarProps {
  room: string | null
  status: SignalingStatus
  peerCount: number
  relayed: boolean
}

const STATUS_TEXT: Record<SignalingStatus, string> = {
  idle: 'desconectado',
  connecting: 'conectando',
  open: 'conectado',
  reconnecting: 'reconectando',
  closed: 'desconectado'
}

export function TitleBar({ room, status, peerCount, relayed }: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.mirante.window.isMaximized().then(setMaximized)
    return window.mirante.window.onState((state) => setMaximized(state.maximized))
  }, [])

  return (
    <header className="tm-titlebar">
      <div className="tm-titlebar__drag">
        <span className="tm-brand">
          <Logo size={16} />
          <span className="tm-brand__type">Mirante</span>
        </span>

        {room && (
          <>
            <span className="tm-titlebar__sep" aria-hidden="true" />
            <span className="tm-titlebar__room">{room}</span>
            <span className="tm-titlebar__count num">
              {peerCount + 1} {peerCount === 0 ? 'pessoa' : 'pessoas'}
            </span>
          </>
        )}

        <span className={`tm-conn tm-conn--${status}`}>
          <span className="tm-conn__dot" />
          {STATUS_TEXT[status]}
        </span>

        {relayed && (
          <span className="tm-chip tm-chip--warn" title="Pelo menos um caminho usa TURN">
            retransmitido
          </span>
        )}
      </div>

      <div className="tm-titlebar__controls">
        <button
          type="button"
          className="tm-wbtn"
          onClick={() => window.mirante.window.minimize()}
          title="Minimizar"
        >
          <IconMinimize size={15} />
        </button>
        <button
          type="button"
          className="tm-wbtn"
          onClick={() => window.mirante.window.toggleMaximize()}
          title={maximized ? 'Restaurar' : 'Maximizar'}
        >
          {maximized ? <IconRestore size={15} /> : <IconMaximize size={15} />}
        </button>
        <button
          type="button"
          className="tm-wbtn tm-wbtn--close"
          onClick={() => window.mirante.window.close()}
          title="Fechar"
        >
          <IconClose size={15} />
        </button>
      </div>
    </header>
  )
}

import { useEffect, useRef, useState, type JSX } from 'react'

import { OFFER_TTL_MS } from '../../../shared/transfer'
import { formatBytes } from '../lib/format'
import type { IncomingTransfer, OutgoingTransfer, Recipient } from '../rtc/transfer'
import { transfers, useSession, useTransfers } from '../rtc/use-session'
import { IconClose, IconFile } from './icons'

const STATE_LABEL: Record<string, string> = {
  offered: 'ofertado',
  sending: 'enviando',
  sent: 'enviado',
  saved: 'salvo',
  expired: 'ninguém aceitou',
  cancelled: 'cancelado',
  denied: 'recusado',
  failed: 'falhou',
  receiving: 'recebendo'
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function percent(bytes: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.round((bytes / total) * 100))
}

function Bar({ value }: { value: number }): JSX.Element {
  return (
    <div className="tm-xfer__bar">
      <span className="tm-xfer__fill" style={{ width: `${value}%` }} />
    </div>
  )
}

function FileList({ entry }: { entry: IncomingTransfer | OutgoingTransfer }): JSX.Element {
  return (
    <ul className="tm-xfer__files">
      {entry.files.map((file) => (
        <li key={file.id}>
          <span className="tm-xfer__file-name" title={file.name}>
            {file.name}
          </span>
          <span className="tm-xfer__file-size">{formatBytes(file.size)}</span>
        </li>
      ))}
    </ul>
  )
}

function IncomingRow({ entry, now }: { entry: IncomingTransfer; now: number }): JSX.Element {
  const total = entry.files.reduce((sum, file) => sum + file.size, 0)
  const seconds =
    entry.expiresAt === null ? 0 : Math.max(0, Math.ceil((entry.expiresAt - now) / 1000))

  return (
    <div className="tm-xfer__row">
      <div className="tm-xfer__title">
        <span className="tm-xfer__from">{entry.fromName}</span>
        {entry.state === 'offered' ? (
          <span className="tm-xfer__time">{seconds}s</span>
        ) : (
          <span className="tm-xfer__state">{STATE_LABEL[entry.state] ?? entry.state}</span>
        )}
      </div>

      <FileList entry={entry} />

      {entry.state === 'receiving' && (
        <>
          <Bar value={percent(entry.bytes, total)} />
          <span className="tm-xfer__meta">
            {formatBytes(entry.bytes)} de {formatBytes(total)}
          </span>
        </>
      )}

      {entry.state === 'saved' && (
        <span className="tm-xfer__meta">
          {entry.files.map((file) => (
            <span key={file.id} className="tm-xfer__saved">
              {baseName(entry.paths[entry.files.indexOf(file)] ?? '')} ·{' '}
              {(entry.hashes[file.id] ?? '').slice(0, 12)}
            </span>
          ))}
        </span>
      )}

      {entry.error && <span className="tm-xfer__error">{entry.error}</span>}

      <div className="tm-xfer__actions">
        {entry.state === 'offered' && (
          <>
            <button type="button" className="tm-btn" onClick={() => void transfers.accept(entry.id)}>
              Aceitar
            </button>
            <button type="button" className="tm-btn" onClick={() => transfers.deny(entry.id)}>
              Recusar
            </button>
          </>
        )}
        {(entry.state === 'receiving' || entry.state === 'offered') && (
          <button
            type="button"
            className="tm-btn"
            onClick={() => transfers.cancelIncoming(entry.id)}
          >
            Cancelar
          </button>
        )}
        {entry.state === 'saved' && entry.paths.length > 0 && (
          <button
            type="button"
            className="tm-btn"
            onClick={() => window.mirante.transfer.reveal(entry.paths[0])}
          >
            Abrir pasta
          </button>
        )}
      </div>
    </div>
  )
}

function RecipientRow({ recipient }: { recipient: Recipient }): JSX.Element {
  return (
    <div className="tm-xfer__recipient">
      <span className="tm-xfer__file-name">{recipient.name}</span>
      <span className="tm-xfer__file-size">
        {recipient.state === 'sent'
          ? 'recebido'
          : recipient.state === 'failed'
            ? (recipient.reason ?? 'falhou')
            : `${percent(recipient.bytes, recipient.total)}%`}
      </span>
    </div>
  )
}

function OutgoingRow({ entry, now }: { entry: OutgoingTransfer; now: number }): JSX.Element {
  const total = entry.files.reduce((sum, file) => sum + file.size, 0)
  const seconds =
    entry.expiresAt === null ? 0 : Math.max(0, Math.ceil((entry.expiresAt - now) / 1000))
  const sent = entry.recipients.filter((recipient) => recipient.state === 'sent').length

  return (
    <div className="tm-xfer__row">
      <div className="tm-xfer__title">
        <span className="tm-xfer__from">
          {entry.files.length === 1 ? entry.files[0].name : `${entry.files.length} arquivos`}
        </span>
        <span className="tm-xfer__state">
          {entry.state === 'offered' && seconds > 0
            ? `${seconds}s`
            : entry.state === 'sent'
              ? `${STATE_LABEL.sent} · ${sent}`
              : (STATE_LABEL[entry.state] ?? entry.state)}
        </span>
      </div>

      <FileList entry={entry} />

      {entry.state === 'offered' && (
        <span className="tm-xfer__meta">na sala, {formatBytes(total)} — 15 s pra aceitar</span>
      )}

      {entry.recipients.map((recipient) => (
        <RecipientRow key={recipient.peerId} recipient={recipient} />
      ))}

      {entry.error && <span className="tm-xfer__error">{entry.error}</span>}

      <div className="tm-xfer__actions">
        {(entry.state === 'offered' || entry.state === 'sending') && (
          <button
            type="button"
            className="tm-btn"
            onClick={() => transfers.cancelOutgoing(entry.id)}
          >
            Cancelar
          </button>
        )}
        {(entry.state === 'expired' ||
          entry.state === 'failed' ||
          entry.state === 'cancelled') && (
          <button type="button" className="tm-btn" onClick={() => transfers.retry(entry.id)}>
            Tentar de novo
          </button>
        )}
      </div>
    </div>
  )
}

export function TransferPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const state = useTransfers()
  const { peers } = useSession()
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      const target = event.target as Node
      if (panel.contains(target)) return
      if ((target as HTMLElement).closest?.('.tm-dock__transfer')) return
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

  const counting =
    state.incoming.some((entry) => entry.state === 'offered') ||
    state.outgoing.some((entry) => entry.state === 'offered')

  useEffect(() => {
    if (!counting) return
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [counting])

  const empty = state.incoming.length === 0 && state.outgoing.length === 0

  return (
    <div className="tm-xfer" ref={panelRef} role="group" aria-label="Transferências de arquivo">
      <div className="tm-xfer__head">
        <span className="label">Transferências</span>
        <span className="tm-xfer__hint label">{OFFER_TTL_MS / 1000} s pra aceitar</span>
        <button type="button" className="tm-xfer__close" onClick={onClose} aria-label="Fechar">
          <IconClose size={12} />
        </button>
      </div>

      {empty && (
        <p className="tm-xfer__empty">
          {peers.length === 0
            ? 'Ninguém na sala pra receber agora.'
            : 'Nada por aqui. Escolha um arquivo e a sala decide em 15 segundos.'}
        </p>
      )}

      {state.incoming.length > 0 && (
        <div className="tm-xfer__section">
          <span className="label">Recebidas</span>
          {state.incoming.map((entry) => (
            <IncomingRow key={entry.id} entry={entry} now={now} />
          ))}
        </div>
      )}

      {state.outgoing.length > 0 && (
        <div className="tm-xfer__section">
          <span className="label">Enviadas</span>
          {state.outgoing.map((entry) => (
            <OutgoingRow key={entry.id} entry={entry} now={now} />
          ))}
        </div>
      )}

      <div className="tm-xfer__foot">
        <input
          ref={inputRef}
          className="tm-xfer__input"
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            if (files.length > 0) transfers.offer(files)
          }}
        />
        <button
          type="button"
          className="tm-btn"
          disabled={peers.length === 0}
          onClick={() => inputRef.current?.click()}
        >
          <IconFile size={14} />
          Escolher arquivo
        </button>
      </div>
    </div>
  )
}

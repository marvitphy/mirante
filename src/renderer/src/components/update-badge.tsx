import { useEffect, useState, type JSX } from 'react'

import type { UpdateState } from '../../../main/updater'

/**
 * Update indicator, parked next to Leave in the dock.
 *
 * Four states, and only one of them asks for anything:
 *
 *   idle         a dim dot you can click to check now
 *   checking     the dot pulses
 *   downloading  a thin determinate bar with the percentage
 *   ready        the one moment it earns attention — an accent button
 *
 * It never restarts on its own. Quitting mid-stream to install an update is
 * the rudest thing a live app can do, so the choice of moment stays with the
 * person watching.
 */

const IDLE: UpdateState = { status: 'idle', version: null, percent: 0, message: null }

export function UpdateBadge(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>(IDLE)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    if (!window.mirante.update) return
    // An unreachable updater is a missing convenience, never an error in
    // someone's face. Swallow and stay idle.
    window.mirante.update
      .state()
      .then(setState)
      .catch((error: unknown) => console.warn('[update] state unavailable:', error))
    return window.mirante.update.onState(setState)
  }, [])

  if (!window.mirante.update) return null

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    try {
      setState(await window.mirante.update.check())
    } catch (error) {
      console.warn('[update] check unavailable:', error)
    } finally {
      setChecking(false)
    }
  }

  if (state.status === 'ready') {
    return (
      <button
        type="button"
        className="tm-btn tm-btn--primary tm-update__cta"
        onClick={() => window.mirante.update.install()}
        title={`Versão ${state.version} baixada — reinicia e aplica`}
      >
        Atualizar
        <span className="tm-update__ver num">{state.version}</span>
      </button>
    )
  }

  if (state.status === 'error') {
    return (
      <button
        type="button"
        className="tm-update tm-update--failed"
        onClick={() => void checkNow()}
        title={`${state.message ?? 'Falha na atualizacao'} — clique pra tentar de novo`}
      >
        <span className="tm-update__dot" />
        <span className="tm-update__text label">tentar de novo</span>
      </button>
    )
  }

  if (state.status === 'downloading') {
    return (
      <div className="tm-update tm-update--busy" title={`Baixando ${state.version ?? ''}`}>
        <span className="tm-update__bar">
          <span className="tm-update__fill" style={{ width: `${state.percent}%` }} />
        </span>
        <span className="tm-update__pct num">{state.percent}%</span>
      </div>
    )
  }

  const busy = checking || state.status === 'checking'
  return (
    <button
      type="button"
      className={`tm-update tm-update--idle${busy ? ' is-busy' : ''}`}
      onClick={() => void checkNow()}
      title={busy ? 'Procurando atualização' : 'Clique pra procurar atualização'}
    >
      <span className="tm-update__dot" />
      <span className="tm-update__text label">{busy ? 'checando' : 'atualizado'}</span>
    </button>
  )
}

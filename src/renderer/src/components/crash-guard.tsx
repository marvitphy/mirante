import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react'

/**
 * Keeps one thrown error from blacking out the whole app.
 *
 * React unmounts the entire tree when a render or an effect cleanup throws,
 * and an unmounted tree is a black window with no menu, no button and no way
 * back — the only move left is killing the process, mid-call, in front of
 * everyone. That happened over one line: `AudioNode.disconnect(node)` throws
 * when the two were never connected, and the throw was inside the settings
 * dialog's cleanup, so merely closing settings ended the session.
 *
 * That specific bug is fixed where it lives. This is here because the shape
 * of the failure was out of all proportion to the mistake, and the next
 * mistake should cost a message rather than the call.
 *
 * Deliberately not a retry button that re-renders the same broken tree: the
 * state that caused the throw is still there. Reloading the window rebuilds
 * it from scratch, which for this app means rejoining — the room, the
 * broadcasts and the people are all on the wire, not in memory.
 */
interface CrashGuardState {
  error: Error | null
}

export class CrashGuard extends Component<{ children: ReactNode }, CrashGuardState> {
  state: CrashGuardState = { error: null }

  static getDerivedStateFromError(error: Error): CrashGuardState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Into the log file by way of the renderer console, which the main
    // process mirrors — so a crash someone hits at home is still readable
    // afterwards instead of being "ficou preto".
    console.error(`[crash] ${error.stack ?? error.message}\n${info.componentStack ?? ''}`)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="tm-crash">
        <div className="tm-crash__card">
          <h1>O Mirante tropeçou</h1>
          <p>
            Alguma coisa quebrou na interface. A sala continua lá — recarregar
            entra de novo.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Recarregar
          </button>
          <pre className="tm-crash__detail">{error.message}</pre>
          <p className="tm-crash__hint">
            O detalhe completo ficou no log, em %APPDATA%\Mirante\logs.
          </p>
        </div>
      </div>
    )
  }
}

export function withCrashGuard(children: ReactNode): JSX.Element {
  return <CrashGuard>{children}</CrashGuard>
}

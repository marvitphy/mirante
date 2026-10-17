import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders its children into the overlay window.
 *
 * The window is opened here, in the renderer, rather than by the main
 * process — and that is the whole reason this works. The tiles show live
 * `MediaStream`s that already exist in this process: cameras and broadcasts
 * being decoded for the main window. A stream cannot cross a process
 * boundary, so a window created by the main process would be a second
 * renderer that could not touch them without encoding everything twice.
 *
 * `window.open` keeps the new window in this same process, where the streams
 * can simply be assigned to a video element. The main process still decides
 * what kind of window it is — transparent, frameless, always on top, and
 * invisible to the mouse until asked — through `setWindowOpenHandler`.
 */

/** Must match OVERLAY_WINDOW_NAME in the main process. */
const WINDOW_NAME = 'mirante-overlay'

/**
 * Copy the app's styles into the overlay document, and keep copying.
 *
 * A new document starts with no stylesheets at all. In a packaged build that
 * is one `<link>`; under `npm run dev` Vite injects `<style>` tags and
 * replaces them on every edit, so a one-time copy would leave the overlay
 * frozen at the styles that existed when it opened.
 */
function mirrorStyles(target: Document): () => void {
  const head = target.head

  const sync = (): void => {
    head.querySelectorAll('[data-mirante-style]').forEach((node) => node.remove())
    document.head
      .querySelectorAll('style, link[rel="stylesheet"]')
      .forEach((node) => {
        const copy = node.cloneNode(true) as HTMLElement
        copy.setAttribute('data-mirante-style', '')
        head.appendChild(copy)
      })
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * The window, held outside React.
 *
 * Opening a window is not an effect that tolerates being run twice, and in
 * development React runs every effect twice on purpose. Left to the normal
 * mount/cleanup rhythm the overlay opened, was torn down, and opened again —
 * which is visible, because an OS window appearing and disappearing is not
 * something a framework can hide.
 *
 * So the window is a singleton with a deferred close: a teardown schedules
 * it, and a mount that arrives before the timer cancels it. The real close
 * still happens; the double-invoke no longer reaches the screen.
 */
let liveWindow: Window | null = null
let pendingClose: number | null = null

function acquireWindow(): Window | null {
  if (pendingClose !== null) {
    window.clearTimeout(pendingClose)
    pendingClose = null
  }
  if (liveWindow && !liveWindow.closed) return liveWindow
  liveWindow = window.open('about:blank', WINDOW_NAME)
  return liveWindow
}

function releaseWindow(): void {
  if (pendingClose !== null) window.clearTimeout(pendingClose)
  pendingClose = window.setTimeout(() => {
    pendingClose = null
    liveWindow?.close()
    liveWindow = null
  }, 60)
}

export function OverlayPortal({
  open,
  children
}: {
  open: boolean
  children: ReactNode
}): JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    const child = acquireWindow()
    if (!child) {
      console.warn('[overlay] window.open recusado')
      return
    }

    const mount = (): (() => void) => {
      const doc = child.document
      doc.title = 'Mirante · overlay'
      doc.documentElement.style.background = 'transparent'
      doc.body.style.cssText = 'margin:0;overflow:hidden;background:transparent'

      const stop = mirrorStyles(doc)
      // A reused window may already have one. Two roots would render the
      // sheet twice, on top of itself.
      const existing = doc.querySelector('.tm-overlay-root')
      const container = (existing as HTMLElement | null) ?? doc.createElement('div')
      container.className = 'tm-overlay-root'
      if (!existing) doc.body.appendChild(container)
      setHost(container)
      return stop
    }

    // about:blank is usually ready immediately, but not always.
    let stopStyles: (() => void) | null = null
    if (child.document.readyState === 'complete') stopStyles = mount()
    else child.addEventListener('load', () => void (stopStyles = mount()))

    const closeOnExit = (): void => {
      liveWindow?.close()
      liveWindow = null
    }
    window.addEventListener('pagehide', closeOnExit)

    return () => {
      window.removeEventListener('pagehide', closeOnExit)
      stopStyles?.()
      setHost(null)
      releaseWindow()
    }
  }, [open])

  if (!host) return null
  return createPortal(children, host)
}

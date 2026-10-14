import { useEffect } from 'react'

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>

/**
 * Window-level keyboard shortcuts for the viewer.
 *
 * Keys are matched case-insensitively against `event.key`. Anything typed into
 * an input is ignored, so the join screen keeps working normally.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return

      const handler = map[event.key.toLowerCase()] ?? map[event.key]
      if (handler) {
        event.preventDefault()
        handler(event)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, map])
}

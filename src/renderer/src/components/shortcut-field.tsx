import { useEffect, useRef, useState, type JSX } from 'react'

/**
 * Record a keyboard shortcut by pressing it.
 *
 * Typing an Electron accelerator by hand means knowing that it is
 * `CommandOrControl+Shift+O` and not `Ctrl+Shift+O`, and getting no feedback
 * when you guess wrong. Pressing the keys is the only input method that
 * cannot be mistyped.
 *
 * Modifiers alone are ignored while recording, so holding Ctrl to reach
 * Ctrl+Shift+O does not capture "Ctrl" the moment it goes down.
 */

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS'])

/** Electron's accelerator spelling, which is not the browser's. */
function toAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null

  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const key = event.key
  if (key === ' ') parts.push('Space')
  else if (key.length === 1) parts.push(key.toUpperCase())
  else if (/^F\d{1,2}$/.test(key)) parts.push(key)
  else if (key === 'Escape' || key === 'Tab' || key === 'Enter') return null
  else parts.push(key)

  // A bare letter is not a global shortcut; it would swallow that key
  // everywhere on the machine.
  if (parts.length < 2) return null
  return parts.join('+')
}

/** How an accelerator reads to a person. */
export function prettyShortcut(accelerator: string): string {
  if (!accelerator) return 'nenhum'
  return accelerator.replace('CommandOrControl', 'Ctrl').split('+').join(' + ')
}

export function ShortcutField({
  value,
  onChange,
  taken = false
}: {
  value: string
  onChange: (accelerator: string) => void
  /** Another application already owns this combination. */
  taken?: boolean
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!recording) return

    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = toAccelerator(event)
      if (!accelerator) return

      onChange(accelerator)
      setRecording(false)
    }

    // Capture phase: the app's own hotkeys listen on window too, and a
    // recording field must not trigger the thing it is recording.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChange, recording])

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`tm-shortcut${recording ? ' is-recording' : ''}${taken ? ' is-taken' : ''}`}
      onClick={() => setRecording((on) => !on)}
      onBlur={() => setRecording(false)}
      title={
        taken
          ? 'Outro programa já usa esse atalho. Escolha outro.'
          : 'Clique e pressione a combinação'
      }
    >
      {recording ? 'pressione…' : prettyShortcut(value)}
    </button>
  )
}

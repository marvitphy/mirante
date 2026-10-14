import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Player-style chrome that fades out while you watch and comes back the moment
 * you move the mouse. The cursor hides with it — nothing should sit on top of
 * someone's gameplay while you are watching it.
 */
export function useAutoHide(delayMs = 2200, enabled = true): {
  visible: boolean
  /** Spread onto the element that should wake the chrome. */
  bind: {
    onMouseMove: () => void
    onMouseLeave: () => void
    onMouseEnter: () => void
  }
  /** Pin the chrome open, e.g. while a popover is on screen. */
  hold: (held: boolean) => void
} {
  const [visible, setVisible] = useState(true)
  const timer = useRef<number | null>(null)
  const held = useRef(false)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const wake = useCallback(() => {
    setVisible(true)
    clear()
    if (!enabled || held.current) return
    timer.current = window.setTimeout(() => setVisible(false), delayMs)
  }, [clear, delayMs, enabled])

  useEffect(() => {
    if (!enabled) {
      clear()
      setVisible(true)
      return
    }
    wake()
    return clear
  }, [clear, enabled, wake])

  const hold = useCallback(
    (value: boolean) => {
      held.current = value
      if (value) {
        clear()
        setVisible(true)
      } else {
        wake()
      }
    },
    [clear, wake]
  )

  return {
    visible,
    bind: {
      onMouseMove: wake,
      onMouseEnter: wake,
      onMouseLeave: () => {
        if (!held.current && enabled) setVisible(false)
      }
    },
    hold
  }
}

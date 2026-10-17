import { useLayoutEffect, useRef } from 'react'

/**
 * Animate elements that moved because the layout changed.
 *
 * A tile dragged to another corner is re-parented into a different dock, and
 * React does that instantly: one frame it is bottom-right, the next it is
 * top-left. Nothing is wrong with the result and it still feels broken,
 * because things in the physical world do not teleport and the eye reads a
 * jump as a glitch rather than as a move.
 *
 * FLIP is the standard answer and the only one that works here: measure
 * where everything was (First), let React put it where it belongs (Last),
 * apply the inverse transform so it *appears* not to have moved (Invert),
 * then animate that transform away (Play). The browser animates a transform
 * on the compositor, so a sheet full of playing video still moves at full
 * frame rate.
 *
 * Elements that are new, or that did not move, are left alone — animating a
 * tile's arrival from wherever a previous tile happened to be is worse than
 * not animating it at all.
 */

/** Settle: quick to leave, slow to arrive, a touch of overshoot. */
const EASE = 'cubic-bezier(0.22, 1.2, 0.36, 1)'
const DURATION_MS = 320

/**
 * @param signature Identifies the LAYOUT, not the render. It must be a
 * string: an array is a new value every render, and this effect measuring on
 * every render is not a small waste — it is a feedback loop. Each run would
 * read a position mid-animation, treat it as where the element "was", and
 * animate again from there. The tiles flickered and crawled around the
 * screen until the component stopped re-rendering, which, with telemetry
 * ticking once a second, was never.
 */
export function useFlip(signature: string): (key: string, node: HTMLElement | null) => void {
  const nodes = useRef(new Map<string, HTMLElement>())
  const previous = useRef(new Map<string, DOMRect>())

  useLayoutEffect(() => {
    const motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches

    for (const [key, node] of nodes.current) {
      const before = previous.current.get(key)
      const after = node.getBoundingClientRect()

      // Already in flight. Measuring it now would capture a frame of the
      // animation rather than a resting place.
      const busy = node.getAnimations().some((animation) => animation.playState === 'running')
      if (busy) continue

      if (before && motionOk) {
        const dx = before.left - after.left
        const dy = before.top - after.top
        // Sub-pixel drift is not a move; animating it only adds blur.
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          node.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: DURATION_MS, easing: EASE }
          )
        }
      }

      previous.current.set(key, after)
    }

    // Forget tiles that are gone, so a camera switched off and on again
    // animates in fresh rather than from where it used to be.
    for (const key of [...previous.current.keys()]) {
      if (!nodes.current.has(key)) previous.current.delete(key)
    }
  }, [signature])

  return (key, node) => {
    if (node) nodes.current.set(key, node)
    else nodes.current.delete(key)
  }
}

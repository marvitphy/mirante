import type { JSX } from 'react'

/**
 * Mirante mark — a lighthouse.
 *
 * A mirante is a lookout: you climb it to see further, and in this app you
 * climb it together. A farol is the same idea with the light pointed outward,
 * which is what a broadcast is.
 *
 * Built from four primitives so it survives being 16px in a taskbar:
 *   - the lamp, a solid block (the brightest thing in the mark)
 *   - two beams, trapezoids widening outward
 *   - the tower, a trapezoid narrowing upward
 *   - the base, a single bar
 *
 * No curves, no gradient, no detail that disappears when small. The exact same
 * geometry is rasterised into the .ico by scripts/make-icon.mjs, so the app
 * icon and the in-app mark can never drift apart.
 */

interface LogoProps {
  size?: number
  /** Dim the beams so the mark reads as "idle" rather than "on air". */
  dark?: boolean
  className?: string
}

export function Logo({ size = 24, dark = false, className }: LogoProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
    >
      {/* light rays — thin and angled, so they read as emission, not as a
          bowtie of two triangles meeting at a block */}
      <path d="M8.8 5.6 L1.2 3.1 L1.2 5.0 L8.8 7.4 Z" fill="currentColor" opacity={dark ? 0.22 : 0.4} />
      <path d="M15.2 5.6 L22.8 3.1 L22.8 5.0 L15.2 7.4 Z" fill="currentColor" opacity={dark ? 0.22 : 0.4} />
      {/* lamp room — the brightest element */}
      <path d="M10.2 4.2 H13.8 V9 H10.2 Z" fill="currentColor" />
      {/* gallery: the lookout balcony you stand on. This is the mirante. */}
      <path d="M8.6 9 H15.4 V10.6 H8.6 Z" fill="currentColor" opacity={0.9} />
      {/* tower — dominant mass, bottom half of the mark */}
      <path d="M9.9 10.6 H14.1 L15.9 21.4 H8.1 Z" fill="currentColor" opacity={0.72} />
      {/* base */}
      <path d="M6 21.4 H18 V23.6 H6 Z" fill="currentColor" />
    </svg>
  )
}

/**
 * Stacked wordmark for the join screen. The rule under it is part of the
 * lockup, not a divider — it is the horizon the lighthouse stands on.
 */
export function Wordmark(): JSX.Element {
  return (
    <div className="tm-wordmark">
      <Logo size={56} className="tm-wordmark__mark" />
      <h1 className="tm-wordmark__type">
        <span>TV</span>
        <span>MIRANTE</span>
      </h1>
    </div>
  )
}

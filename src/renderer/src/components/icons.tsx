import type { JSX, SVGProps } from 'react'

/**
 * Inline icons. Hand-drawn on a 24-grid with a 1.75 stroke — slightly heavier
 * than the usual 1.5 so they hold up against the dark surfaces without needing
 * a fill. No icon dependency: twelve glyphs do not justify a package.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 18, children, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconScreen = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="2.5" y="4" width="19" height="13" rx="2" />
    <path d="M8.5 20.5h7M12 17v3.5" />
  </Icon>
)

export const IconCamera = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="13" height="12" rx="2.5" />
    <path d="M15.5 10.5 21.5 7v10l-6-3.5z" />
  </Icon>
)

export const IconCameraOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M2.5 8.5A2.5 2.5 0 0 1 5 6h6" />
    <path d="M15.5 12.5V16a2 2 0 0 1-2 2H5a2.5 2.5 0 0 1-2.5-2.5V11" />
    <path d="m15.5 10.5 6-3.5v10l-3-1.75" />
    <path d="m3 3 18 18" />
  </Icon>
)

export const IconImage = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.75" />
    <path d="M21 15.5l-5-5-9.5 9" />
  </Icon>
)

export const IconMic = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v4M8.5 21.5h7" />
  </Icon>
)

export const IconMicOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M9 5.5A3 3 0 0 1 15 5.5v4" />
    <path d="M15 13.2a3 3 0 0 1-6-1.7V9" />
    <path d="M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11v.5" />
    <path d="M12 17.5v4M8.5 21.5h7M3 3l18 18" />
  </Icon>
)

export const IconExpand = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M9 3.5H3.5V9M15 3.5h5.5V9M9 20.5H3.5V15M15 20.5h5.5V15" />
  </Icon>
)

export const IconCollapse = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M3.5 9H9V3.5M20.5 9H15V3.5M3.5 15H9v5.5M20.5 15H15v5.5" />
  </Icon>
)

/**
 * Four panes and one pane: a pair, and the pair is the point.
 *
 * These two buttons swap the stage between several broadcasts and one, so
 * each glyph is simply a picture of the layout it produces. The window
 * chrome icons that were standing in here — minimise and maximise — describe
 * what happens to a WINDOW, which is a different thing entirely and is why
 * neither button read as what it did.
 */
export const IconGrid = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" />
    <rect x="13.5" y="3.5" width="7" height="7" />
    <rect x="3.5" y="13.5" width="7" height="7" />
    <rect x="13.5" y="13.5" width="7" height="7" />
  </Icon>
)

export const IconSolo = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" />
    {/* Corner ticks: this pane is about to take the room. */}
    <path d="M7 8.5h3M7 8.5v2.5" />
    <path d="M17 15.5h-3M17 15.5v-2.5" />
  </Icon>
)

export const IconTheater = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
  </Icon>
)

export const IconVolume = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="M16 9.2a4 4 0 0 1 0 5.6M18.8 6.6a7.5 7.5 0 0 1 0 10.8" />
  </Icon>
)

export const IconVolumeOff = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    <path d="m16.5 9.5 5 5M21.5 9.5l-5 5" />
  </Icon>
)

export const IconSignal = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M4 19v-3M9.3 19v-6.5M14.7 19V9M20 19V5.5" />
  </Icon>
)

export const IconClose = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="m5 5 14 14M19 5 5 19" />
  </Icon>
)

export const IconMinimize = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M5 12h14" />
  </Icon>
)

export const IconMaximize = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="5" y="5" width="14" height="14" rx="1.5" />
  </Icon>
)

export const IconRestore = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <rect x="4.5" y="7.5" width="12" height="12" rx="1.5" />
    <path d="M8 7.5V6a1.5 1.5 0 0 1 1.5-1.5H18A1.5 1.5 0 0 1 19.5 6v8.5A1.5 1.5 0 0 1 18 16h-1.5" />
  </Icon>
)

export const IconLeave = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15" />
    <path d="M11 8.5 15 12l-4 3.5M15 12H4" />
  </Icon>
)

/** Three faders at different heights — a picture of the panel it opens. */
export const IconSliders = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <path d="M6 20v-6M6 10V4M12 20v-9M12 7V4M18 20v-3M18 13V4" />
    <path d="M3.5 13h5M9.5 8.5h5M15.5 15.5h5" />
  </Icon>
)

export const IconSettings = (p: IconProps): JSX.Element => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.5 12a7.5 7.5 0 0 0-.12-1.33l2-1.55-2-3.46-2.37.95a7.5 7.5 0 0 0-2.3-1.33L14.3 2.8h-4l-.4 2.48a7.5 7.5 0 0 0-2.3 1.33l-2.38-.95-2 3.46 2 1.55a7.5 7.5 0 0 0 0 2.66l-2 1.55 2 3.46 2.37-.95a7.5 7.5 0 0 0 2.3 1.33l.41 2.48h4l.4-2.48a7.5 7.5 0 0 0 2.3-1.33l2.38.95 2-3.46-2-1.55c.08-.44.12-.88.12-1.33Z" />
  </Icon>
)

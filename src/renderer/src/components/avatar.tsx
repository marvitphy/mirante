import type { JSX } from 'react'

/**
 * Someone with no picture, as a letter in their own colour.
 *
 * The hue comes from the peer id, so one person looks the same to everyone
 * in the room. Lightness and saturation are fixed, so no avatar ever
 * out-shouts the stage.
 */
export function Avatar({ name, hue }: { name: string; hue: number }): JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="tm-avatar"
      style={{ background: `hsl(${hue} 40% 24%)`, color: `hsl(${hue} 70% 80%)` }}
    >
      {initial}
    </span>
  )
}

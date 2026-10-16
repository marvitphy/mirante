/**
 * Who you are to the server, across restarts.
 *
 * The server de-duplicates a room by replacing any session carrying the same
 * client id. That only works if the id outlives the thing going wrong. It
 * used to be `crypto.randomUUID()` evaluated when the session object was
 * built — so every app restart, every renderer reload, every update arrived
 * as a brand new stranger, and you appeared in the room twice until the old
 * socket was eventually reaped. The de-duplication was real; the identity it
 * depended on was not.
 *
 * So the id is persisted. That raises one question immediately: two windows
 * of the same install share localStorage, and giving them the same id would
 * make them evict each other — which is exactly how someone tests this alone
 * with two copies open. Hence the slot: each window claims the lowest number
 * nobody is currently holding, and holds it with a heartbeat. One window gets
 * the bare install id, a second gets `#1`, and a window that crashed stops
 * holding anything a few seconds later.
 */

const INSTALL_KEY = 'mirante.installId'
const SLOT_PREFIX = 'mirante.slot.'
/** How often a window renews its claim. */
const HEARTBEAT_MS = 2_000
/** A claim older than this belonged to a window that is gone. */
const STALE_MS = 7_000
/** Nobody runs more copies than this; past it we stop looking and reuse 0. */
const MAX_SLOTS = 8

function installId(): string {
  try {
    const stored = localStorage.getItem(INSTALL_KEY)
    if (stored) return stored
    const minted = crypto.randomUUID()
    localStorage.setItem(INSTALL_KEY, minted)
    return minted
  } catch {
    // Private mode, disabled storage: fall back to a per-run identity. The
    // duplicate problem comes back, but the app still works.
    return crypto.randomUUID()
  }
}

function claimSlot(): number {
  const now = Date.now()
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    try {
      const raw = localStorage.getItem(SLOT_PREFIX + slot)
      const heldAt = raw === null ? 0 : Number(raw)
      if (Number.isFinite(heldAt) && now - heldAt < STALE_MS) continue
      localStorage.setItem(SLOT_PREFIX + slot, String(now))
      return slot
    } catch {
      return 0
    }
  }
  return 0
}

let cached: string | null = null

/** Stable across restarts, distinct between windows running side by side. */
export function clientId(): string {
  if (cached !== null) return cached

  const slot = claimSlot()
  const base = installId()
  cached = slot === 0 ? base : `${base}#${slot}`

  // Keep holding the slot. Without this a second window would take it over
  // seven seconds in and the two would start evicting each other mid-call.
  window.setInterval(() => {
    try {
      localStorage.setItem(SLOT_PREFIX + slot, String(Date.now()))
    } catch {
      // Nothing to do; the claim simply goes stale.
    }
  }, HEARTBEAT_MS)

  // Let go on the way out, so a restart reclaims the same slot instead of
  // taking the next one.
  //
  // Without this, updating was guaranteed to change your identity: the app
  // relaunches two or three seconds after quitting, well inside the seven
  // second staleness window, so the slot it had just vacated still looked
  // occupied and the new window claimed `#1`. A different client id is a
  // different person as far as the server is concerned — which is to say
  // every single update produced a duplicate of whoever installed it.
  window.addEventListener('pagehide', () => {
    try {
      localStorage.removeItem(SLOT_PREFIX + slot)
    } catch {
      // Then it goes stale on its own; that path still works.
    }
  })

  return cached
}

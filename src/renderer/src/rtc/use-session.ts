import { useSyncExternalStore } from 'react'

import { MeshSession, type SessionSnapshot } from './mesh-session'
import type { TransferSnapshot } from './transfer'

/**
 * One session per app instance. Deliberately module-scoped rather than context:
 * the session owns live PeerConnections and must survive React remounts and
 * fast-refresh without dropping media.
 */
export const session = new MeshSession()

export const transfers = session.transfers

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

export function useTransfers(): TransferSnapshot {
  return useSyncExternalStore(
    transfers.subscribe,
    transfers.getSnapshot,
    transfers.getSnapshot
  )
}

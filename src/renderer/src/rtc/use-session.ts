import { useSyncExternalStore } from 'react'

import { MeshSession, type SessionSnapshot } from './mesh-session'

/**
 * One session per app instance. Deliberately module-scoped rather than context:
 * the session owns live PeerConnections and must survive React remounts and
 * fast-refresh without dropping media.
 */
export const session = new MeshSession()

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
}

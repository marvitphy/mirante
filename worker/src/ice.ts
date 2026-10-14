import type { RTCIceServerConfig } from '../../src/shared/protocol'

/**
 * ICE servers handed to each peer on join.
 *
 * STUN alone is enough for most home networks: it tells a peer its public
 * address so the two sides can punch a hole straight through. It is not
 * enough for symmetric NAT or CGNAT — common on mobile tethering and some
 * Brazilian ISPs — where a relay is the only path that works.
 *
 * Media that goes through TURN is slower than a direct path, so TURN is never
 * preferred: ICE already ranks relay candidates last and only falls back to
 * them when nothing direct connects.
 */

export interface IceEnv {
  STUN_URLS?: string
  /** Cloudflare Realtime TURN. Free tier covers 1 TB/month. */
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  CLOUDFLARE_TURN_TTL?: string
  /** Self-hosted coturn with `use-auth-secret`. */
  TURN_URLS?: string
  TURN_SECRET?: string
  TURN_TTL?: string
}

const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'
const CLOUDFLARE_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys'

interface Cached {
  servers: RTCIceServerConfig[]
  expiresAt: number
}

/** Credentials are not peer-bound, so one fetch serves everyone for a while. */
let cloudflareCache: Cached | null = null
let cooldownUntil = 0

function list(value: string | undefined, fallback = ''): string[] {
  return (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function cloudflareTurn(env: IceEnv): Promise<RTCIceServerConfig[]> {
  const keyId = env.CLOUDFLARE_TURN_KEY_ID
  const token = env.CLOUDFLARE_TURN_API_TOKEN
  if (!keyId || !token) return []

  const now = Date.now()
  if (cloudflareCache && cloudflareCache.expiresAt > now) return cloudflareCache.servers
  if (now < cooldownUntil) return []

  const ttl = Number(env.CLOUDFLARE_TURN_TTL ?? 86_400)

  try {
    const response = await fetch(`${CLOUDFLARE_ENDPOINT}/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
      signal: AbortSignal.timeout(4000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const body = (await response.json()) as { iceServers?: RTCIceServerConfig | RTCIceServerConfig[] }
    const servers = Array.isArray(body.iceServers)
      ? body.iceServers
      : body.iceServers
        ? [body.iceServers]
        : []
    if (servers.length === 0) throw new Error('resposta sem iceServers')

    // Refresh at half-life so a credential never expires mid-session.
    cloudflareCache = { servers, expiresAt: now + (ttl * 1000) / 2 }
    cooldownUntil = 0
    return servers
  } catch (error) {
    // One provider outage must not stall every join with retries.
    console.warn('[ice] cloudflare turn unavailable:', (error as Error).message)
    cooldownUntil = Date.now() + 60_000
    return []
  }
}

/**
 * coturn `use-auth-secret`: username is `<expiry>:<peer>`, password is the
 * base64 HMAC-SHA1 of that username under the shared secret.
 */
async function coturn(env: IceEnv, peerId: string): Promise<RTCIceServerConfig[]> {
  const urls = list(env.TURN_URLS)
  const secret = env.TURN_SECRET
  if (urls.length === 0 || !secret) return []

  const expiry = Math.floor(Date.now() / 1000) + Number(env.TURN_TTL ?? 43_200)
  const username = `${expiry}:${peerId}`

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username))
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)))

  return [{ urls, username, credential }]
}

export async function resolveIceServers(
  env: IceEnv,
  peerId: string
): Promise<RTCIceServerConfig[]> {
  const servers: RTCIceServerConfig[] = []

  const stun = list(env.STUN_URLS, DEFAULT_STUN)
  if (stun.length > 0) servers.push({ urls: stun })

  servers.push(...(await cloudflareTurn(env)))
  servers.push(...(await coturn(env, peerId)))

  return servers
}

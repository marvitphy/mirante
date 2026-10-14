import { createHmac } from 'node:crypto'

import type { RTCIceServerConfig } from '../../src/shared/protocol.ts'

/**
 * ICE server resolution.
 *
 * The TeamSpeak teardown found no `typ relay` candidate in any logged session
 * and no `turn:` string in the binary — their observed fallback ladder stops at
 * TCP host candidates, so a symmetric-NAT pair simply never connects. Fixing
 * that is the clearest win available to us, and it only works if relays are
 * actually configured.
 *
 * Three providers, stacked:
 *
 *   1. STUN — free, tells a peer its public address. Never relays media.
 *   2. Cloudflare TURN — global anycast, and critically offers
 *      `turns:…:443?transport=tcp`, which looks like HTTPS and therefore
 *      survives corporate firewalls that drop UDP wholesale.
 *   3. Self-hosted coturn — the `use-auth-secret` REST scheme.
 *
 * ## Why not stack five relays
 *
 * Each TURN URL costs an allocation request during ICE gathering, and every
 * extra candidate multiplies the connectivity-check matrix (pairs grow as
 * local × remote). Two relay providers is redundancy; five is a slow join.
 * Cloudflare alone already publishes six URLs in one entry.
 */

export interface IceConfig {
  stunUrls: string[]
  cloudflare: { keyId: string; apiToken: string; ttlSeconds: number } | null
  coturn: { urls: string[]; secret: string; ttlSeconds: number } | null
}

export function readIceConfig(env: NodeJS.ProcessEnv): IceConfig {
  const list = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const cfKeyId = env.CLOUDFLARE_TURN_KEY_ID
  const cfToken = env.CLOUDFLARE_TURN_API_TOKEN

  return {
    stunUrls: list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302'),
    cloudflare:
      cfKeyId && cfToken
        ? {
            keyId: cfKeyId,
            apiToken: cfToken,
            ttlSeconds: Number(env.CLOUDFLARE_TURN_TTL_SECONDS ?? 86_400)
          }
        : null,
    coturn:
      list(env.TURN_URLS).length > 0 && env.TURN_SECRET
        ? {
            urls: list(env.TURN_URLS),
            secret: env.TURN_SECRET,
            ttlSeconds: Number(env.TURN_TTL_SECONDS ?? 12 * 60 * 60)
          }
        : null
  }
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

const CLOUDFLARE_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys'

interface CloudflareResponse {
  iceServers?: RTCIceServerConfig | RTCIceServerConfig[]
}

interface CachedCredentials {
  servers: RTCIceServerConfig[]
  expiresAt: number
}

let cloudflareCache: CachedCredentials | null = null
/** Set after a failure so one outage does not stall every join with retries. */
let cloudflareCooldownUntil = 0
const COOLDOWN_MS = 60_000

/**
 * Cloudflare credentials are not bound to a peer, so one fetch serves everyone
 * until halfway through its TTL. That keeps joins instant and the API quiet.
 */
async function fetchCloudflare(
  config: NonNullable<IceConfig['cloudflare']>
): Promise<RTCIceServerConfig[]> {
  const now = Date.now()
  if (cloudflareCache && cloudflareCache.expiresAt > now) return cloudflareCache.servers
  if (now < cloudflareCooldownUntil) return []

  const controller = new AbortController()
  // A join must not hang on someone else's API.
  const timeout = setTimeout(() => controller.abort(), 4_000)

  try {
    const response = await fetch(
      `${CLOUDFLARE_ENDPOINT}/${config.keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ ttl: config.ttlSeconds }),
        signal: controller.signal
      }
    )

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${await response.text().catch(() => '')}`)
    }

    const body = (await response.json()) as CloudflareResponse
    // The API has returned both a bare object and an array across versions.
    const servers = Array.isArray(body.iceServers)
      ? body.iceServers
      : body.iceServers
        ? [body.iceServers]
        : []

    if (servers.length === 0) throw new Error('resposta sem iceServers')

    cloudflareCache = {
      servers,
      // Refresh at half-life so a credential never expires mid-session.
      expiresAt: now + (config.ttlSeconds * 1000) / 2
    }
    cloudflareCooldownUntil = 0
    return servers
  } catch (error) {
    cloudflareCooldownUntil = Date.now() + COOLDOWN_MS
    console.warn(
      `[ice] Cloudflare TURN indisponivel (${(error as Error).message}). ` +
        'Seguindo com os outros provedores por 60s.'
    )
    return []
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// coturn
// ---------------------------------------------------------------------------

/**
 * coturn `use-auth-secret` scheme:
 *   username = "<unix-expiry>:<peer-id>"
 *   password = base64(HMAC-SHA1(username, shared secret))
 */
function mintCoturn(
  config: NonNullable<IceConfig['coturn']>,
  peerId: string
): RTCIceServerConfig {
  const expiry = Math.floor(Date.now() / 1000) + config.ttlSeconds
  const username = `${expiry}:${peerId}`
  return {
    urls: config.urls,
    username,
    credential: createHmac('sha1', config.secret).update(username).digest('base64')
  }
}

// ---------------------------------------------------------------------------

/**
 * Build the ICE server list handed to one peer in its `welcome`.
 *
 * Order is STUN, then relays. ICE assigns relay candidates the lowest priority
 * on its own, so a direct path is always preferred regardless of what this
 * list looks like — the relays are insurance, not a route.
 */
export async function resolveIceServers(
  config: IceConfig,
  peerId: string
): Promise<RTCIceServerConfig[]> {
  const servers: RTCIceServerConfig[] = []

  if (config.stunUrls.length > 0) servers.push({ urls: config.stunUrls })
  if (config.cloudflare) servers.push(...(await fetchCloudflare(config.cloudflare)))
  if (config.coturn) servers.push(mintCoturn(config.coturn, peerId))

  return servers
}

export function describeIceConfig(config: IceConfig): string[] {
  const lines = [`  STUN:       ${config.stunUrls.join(', ') || '(nenhum)'}`]
  lines.push(
    `  Cloudflare: ${config.cloudflare ? `key ${config.cloudflare.keyId.slice(0, 8)}…` : '(nao configurado)'}`
  )
  lines.push(`  coturn:     ${config.coturn ? config.coturn.urls.join(', ') : '(nao configurado)'}`)
  if (!config.cloudflare && !config.coturn) {
    lines.push(
      '  AVISO: sem TURN. Quem estiver atras de NAT simetrico nao vai conseguir conectar.'
    )
  }
  return lines
}

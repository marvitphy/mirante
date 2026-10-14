/** Bindings and variables declared in wrangler.jsonc. */
interface Env {
  ROOM: DurableObjectNamespace
  MAX_PEERS_PER_ROOM?: string
  STUN_URLS?: string
  CLOUDFLARE_TURN_KEY_ID?: string
  CLOUDFLARE_TURN_API_TOKEN?: string
  CLOUDFLARE_TURN_TTL?: string
  TURN_URLS?: string
  TURN_SECRET?: string
  TURN_TTL?: string
}

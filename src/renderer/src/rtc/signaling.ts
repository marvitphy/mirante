import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage
} from '../../../shared/protocol'

/**
 * WebSocket signaling client with automatic reconnect.
 *
 * Signaling going down must never kill media. Established peer connections keep
 * running on their own; this socket only matters for discovering new peers and
 * for ICE restarts. That separation is why `reconnectOffer` exists as a verb.
 */

export type SignalingStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface SignalingOptions {
  url: string
  room: string
  name: string
  onMessage: (message: ServerMessage) => void
  onStatus: (status: SignalingStatus) => void
}

const RECONNECT_BASE_MS = 600
const RECONNECT_MAX_MS = 8_000
/**
 * Keepalive period.
 *
 * Was 5 s, which is 17,280 messages per peer per day — on Cloudflare a
 * WebSocket message is a billed request, so a few friends idling would have
 * eaten the whole free tier on keepalives. At 25 s it is under 3,500, and the
 * literal 'ping' below is auto-answered at the edge without waking the
 * Durable Object at all.
 */
const PING_INTERVAL_MS = 25_000

export class Signaling {
  private socket: WebSocket | null = null
  private attempt = 0
  private closedByUser = false
  private pingTimer: number | null = null
  private reconnectTimer: number | null = null
  /** Round-trip time to the signaling server. Not the media path, but a useful floor. */
  private lastRtt = 0

  constructor(private readonly options: SignalingOptions) {}

  get rtt(): number {
    return this.lastRtt
  }

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  private open(): void {
    const url = this.options.url.trim()
    // A bad address must surface as a message, not as an uncaught
    // SyntaxError. Anything without a ws:// or wss:// scheme would be
    // resolved against the page origin — file:// in a packaged build.
    if (!/^wss?:\/\//i.test(url)) {
      this.options.onStatus('closed')
      this.options.onMessage({
        t: 'error',
        code: 'bad_server_url',
        message:
          `Endereco de servidor invalido: "${this.options.url}". ` +
          'Use ws:// ou wss:// em "Outro servidor".'
      })
      return
    }

    this.options.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')

    // The exact address, including the room path. Two people "in the same
    // room" who cannot see each other are usually on two different URLs, and
    // guessing which is a waste of everyone's evening.
    console.log(`[signal] connecting to ${url}`)

    const socket = new WebSocket(url)
    this.socket = socket

    socket.addEventListener('open', () => {
      this.attempt = 0
      this.options.onStatus('open')
      this.send({
        t: 'hello',
        version: PROTOCOL_VERSION,
        room: this.options.room,
        name: this.options.name
      })
      this.startPing()
    })

    socket.addEventListener('message', (event: MessageEvent<string>) => {
      // Auto-responded keepalive; nothing to do.
      if (event.data === 'pong') return

      let message: ServerMessage
      try {
        message = JSON.parse(event.data) as ServerMessage
      } catch {
        return
      }
      if (message.t === 'pong') {
        this.lastRtt = Date.now() - message.ts
        return
      }
      if (message.t === 'welcome') {
        console.log(
          `[signal] welcome: eu=${message.self.name}/${message.self.id.slice(0, 8)}, ` +
            `ja na sala=[${message.peers.map((p) => p.name).join(', ') || 'ninguem'}], ` +
            `ice=${message.iceServers.length} servidores`
        )
      }
      if (message.t === 'peerJoined') console.log(`[signal] entrou: ${message.peer.name}`)
      if (message.t === 'peerLeft') console.log(`[signal] saiu: ${message.id.slice(0, 8)}`)
      this.options.onMessage(message)
    })

    socket.addEventListener('close', () => {
      this.stopPing()
      this.socket = null
      if (this.closedByUser) {
        this.options.onStatus('closed')
        return
      }
      this.scheduleReconnect()
    })

    socket.addEventListener('error', () => socket.close())
  }

  private scheduleReconnect(): void {
    this.attempt += 1
    // Exponential backoff with jitter, so a server restart does not get
    // hammered by every client waking at the same millisecond.
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS)
    const delay = base * (0.7 + Math.random() * 0.6)
    this.options.onStatus('reconnecting')
    this.reconnectTimer = window.setTimeout(() => this.open(), delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = window.setInterval(() => {
      // A bare string, not JSON: it has to match the auto-response pair the
      // worker registers exactly. The old JSON ping measured signalling RTT,
      // which was never shown anywhere — the latency in the UI comes from
      // getStats() on the peer connection, which is the number that matters.
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('ping')
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  close(): void {
    this.closedByUser = true
    this.stopPing()
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Announce the departure before dropping the socket. The close handshake
    // is asynchronous and can land after a subsequent join, which is how the
    // same person ended up in a room several times over.
    this.send({ t: 'bye' })
    this.socket?.close()
    this.socket = null
    this.options.onStatus('closed')
  }
}

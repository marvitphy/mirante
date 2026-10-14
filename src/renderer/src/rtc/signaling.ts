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
const PING_INTERVAL_MS = 5_000

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
    this.options.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')

    const socket = new WebSocket(this.options.url)
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
      this.send({ t: 'ping', ts: Date.now() })
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

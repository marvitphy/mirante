import { DurableObject } from 'cloudflare:workers'

import {
  PROTOCOL_VERSION,
  emptyPublishState,
  hueFromId,
  type ClientMessage,
  type PeerInfo,
  type PeerPublishState,
  type RTCIceServerConfig,
  type ServerMessage
} from '../../src/shared/protocol'
import { resolveIceServers, type IceEnv } from './ice'

/**
 * One room, one Durable Object.
 *
 * A Durable Object is a single-threaded actor with a stable identity, which is
 * exactly the shape of a signalling room: everyone in `salinha` is routed to
 * the same instance, so the peer list is just a field. No database, no
 * coordination, no cross-instance messaging.
 *
 * ## Hibernation, and why the ping design changed
 *
 * The free plan bills 100,000 requests a day, and a WebSocket MESSAGE counts
 * as a request. The original Node server pinged every 5 seconds to measure
 * round-trip time: 17,280 messages per peer per day. Three friends talking all
 * afternoon would have burned through the free tier on keepalives alone.
 *
 * Two changes fix that:
 *
 * 1. `setWebSocketAutoResponse` makes the runtime answer the keepalive at the
 *    edge — the Durable Object is never woken and the message is not billed.
 * 2. `ctx.acceptWebSocket` (rather than `ws.accept()`) lets the object be
 *    evicted from memory while sockets stay connected. Peers idling between
 *    streams cost nothing.
 *
 * The signalling RTT that the old ping measured was never displayed anywhere —
 * the latency in the UI comes from `getStats()` on the peer connection, which
 * is the number that actually matters.
 */

/** Survives hibernation by riding on the socket itself. */
interface Attachment {
  info: PeerInfo
  state: PeerPublishState
  /** Stable across this client's reconnects. See the protocol comment. */
  clientId: string
}

/**
 * How often an occupied room re-announces itself to the directory.
 *
 * The directory expires an entry it has not heard from, because a room
 * that dies without cleaning up is indistinguishable from a quiet one.
 * This has to beat comfortably inside that window.
 */
const HEARTBEAT_MS = 25_000

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered by the runtime without waking us. Must be a literal match.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))

    // The name has to be read back from storage before anything can run,
    // because hibernation destroys this object and rebuilds it. As a plain
    // field it came back empty, every room reported itself under "", they
    // all overwrote each other in the directory, and no room ever
    // disappeared — one would clear the key and the next heartbeat would
    // put it straight back.
    ctx.blockConcurrencyWhile(async () => {
      this.name = (await ctx.storage.get<string>('name')) ?? ''
    })
  }

  /**
   * Tell the directory what is in here now.
   *
   * Called after anything that changes the answer — someone arriving,
   * leaving, or starting a broadcast — and on a timer while occupied. Never
   * awaited by the protocol path: the census failing must not be able to
   * delay or break somebody joining a room.
   */
  private report(): void {
    // Without a name there is nothing the directory can key on, and an
    // entry under "" is one every other room will fight over.
    if (!this.name) return

    const inside = this.peers()
    let live = false
    let showing: string | undefined
    let since = Number.MAX_SAFE_INTEGER

    for (const { data } of inside) {
      if (data.state.screen) {
        live = true
        // First publisher wins. With two broadcasts the entrance is not the
        // place to disambiguate — walking in is.
        showing ??= data.state.screenLabel
      }
      if (data.info.joinedAt < since) since = data.info.joinedAt
    }

    const body = JSON.stringify({
      room: this.name,
      people: inside.map(({ data }) => ({ name: data.info.name, hue: data.info.hue })),
      live,
      showing,
      since: inside.length > 0 ? since : Date.now()
    })

    this.ctx.waitUntil(
      this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('global'))
        .fetch('https://directory/report', { method: 'POST', body })
        .then(() => undefined)
        .catch(() => undefined)
    )

    // Keep beating only while there is something to report. An empty room
    // that keeps waking itself up forever is a room nobody is in, costing
    // money.
    if (inside.length > 0) void this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
  }

  /** The heartbeat. Re-reports, or goes quiet if everyone has gone. */
  async alarm(): Promise<void> {
    this.report()
  }

  /**
   * This room's own name.
   *
   * A Durable Object addressed by name cannot read that name back, so the
   * Worker passes it on the upgrade. Kept in storage rather than memory
   * because this object does not survive hibernation and the directory
   * lists rooms by the name people type.
   */
  private name = ''

  async fetch(request: Request): Promise<Response> {
    const named = new URL(request.url).searchParams.get('name')
    if (named && named !== this.name) {
      this.name = named
      await this.ctx.storage.put('name', named)
    }

    // Diagnostics. Knowing the room name already lets anyone join it and see
    // the same list, so this exposes nothing new — it just makes the server's
    // own view readable without a client attached.
    if (new URL(request.url).searchParams.has('peers')) {
      return Response.json({
        peers: this.peers().map(({ data }) => ({
          name: data.info.name,
          id: data.info.id.slice(0, 8),
          joinedAt: new Date(data.info.joinedAt).toISOString(),
          publishing: data.state
        })),
        sockets: this.ctx.getWebSockets().length
      })
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)

    return new Response(null, { status: 101, webSocket: client })
  }

  // --- helpers ------------------------------------------------------------

  private peers(): Array<{ socket: WebSocket; data: Attachment }> {
    const out: Array<{ socket: WebSocket; data: Attachment }> = []
    for (const socket of this.ctx.getWebSockets()) {
      const data = socket.deserializeAttachment() as Attachment | null
      if (data) out.push({ socket, data })
    }
    return out
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      // Socket died between lookup and send; close handling will clean up.
    }
  }

  private broadcast(message: ServerMessage, exceptId?: string): void {
    for (const { socket, data } of this.peers()) {
      if (data.info.id !== exceptId) this.send(socket, message)
    }
  }

  // --- protocol -----------------------------------------------------------

  async webSocketMessage(socket: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    if (typeof raw !== 'string') return

    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      return
    }

    const self = socket.deserializeAttachment() as Attachment | null

    if (msg.t === 'hello') {
      if (self) return
      if (msg.version !== PROTOCOL_VERSION) {
        this.send(socket, {
          t: 'error',
          code: 'version_mismatch',
          message: `Servidor fala v${PROTOCOL_VERSION}, cliente fala v${msg.version}.`
        })
        socket.close(1002, 'version mismatch')
        return
      }

      // Two cleanups before counting, both learned the hard way.
      //
      // A socket can be dead without the runtime having told us — the client
      // crashed, the laptop slept, the process was killed. Until it is
      // reaped its owner still occupies a slot and still shows in the room.
      for (const { socket: other, data } of this.peers()) {
        if (other.readyState > WebSocket.OPEN) {
          other.serializeAttachment(null)
          this.broadcast({ t: 'peerLeft', id: data.info.id })
        }
      }

      // And a client that reconnects is the SAME person, not a new one.
      // Without this the room filled up with duplicates of whoever had a
      // flaky connection — two `dellannu`, two `cyk`, each with a different
      // colour because each had a fresh peer id.
      for (const { socket: other, data } of this.peers()) {
        if (data.clientId !== msg.clientId) continue
        other.serializeAttachment(null)
        this.broadcast({ t: 'peerLeft', id: data.info.id })
        try {
          other.close(1000, 'replaced by reconnect')
        } catch {
          // Already gone; the attachment is cleared either way.
        }
      }

      const existing = this.peers()
      const limit = Number(this.env.MAX_PEERS_PER_ROOM ?? 8)
      if (existing.length >= limit) {
        this.send(socket, {
          t: 'error',
          code: 'room_full',
          message: `Sala cheia (${limit}). Mesh P2P nao escala alem disso.`
        })
        socket.close(1013, 'room full')
        return
      }

      const id = crypto.randomUUID()
      const info: PeerInfo = {
        id,
        clientId: msg.clientId,
        name: (msg.name || 'convidado').slice(0, 32),
        hue: hueFromId(id),
        joinedAt: Date.now()
      }
      const attachment: Attachment = {
        info,
        state: emptyPublishState(),
        clientId: msg.clientId
      }
      socket.serializeAttachment(attachment)

      let iceServers: RTCIceServerConfig[] = []
      try {
        iceServers = await resolveIceServers(this.env as unknown as IceEnv, id)
      } catch {
        // Never let an ICE provider outage block someone from joining; they
        // can still reach anyone on a direct path.
      }

      this.send(socket, {
        t: 'welcome',
        self: info,
        peers: existing.map((p) => ({ ...p.data.info, state: p.data.state })),
        iceServers
      })
      this.broadcast({ t: 'peerJoined', peer: info, state: attachment.state }, id)
      this.report()
      return
    }

    if (!self) return

    switch (msg.t) {
      case 'publishState': {
        socket.serializeAttachment({ ...self, state: msg.state })
        this.broadcast({ t: 'peerState', id: self.info.id, state: msg.state }, self.info.id)
        // Starting or stopping a broadcast changes whether this room is
        // worth walking into, which is the most useful thing the list says.
        this.report()
        break
      }
      case 'chat': {
        // Every WebSocket message here is a billed request, but this costs no
        // more than the peerState broadcast above: no storage, no alarm, just
        // a fan-out to the sockets already attached to this room.
        const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : ''
        if (!text) break
        this.broadcast({
          t: 'chat',
          from: self.info.id,
          clientId: self.clientId,
          name: self.info.name,
          hue: self.info.hue,
          text,
          at: Date.now()
        })
        break
      }
      case 'join': {
        const target = this.peers().find((p) => p.data.info.id === msg.to)
        if (target) this.send(target.socket, { t: 'join', from: self.info.id })
        break
      }
      case 'watchVideo': {
        const target = this.peers().find((p) => p.data.info.id === msg.to)
        if (target) {
          this.send(target.socket, {
            t: 'watchVideo',
            from: self.info.id,
            video: msg.video
          })
        }
        break
      }

      case 'leaveStream': {
        const target = this.peers().find((p) => p.data.info.id === msg.to)
        if (target) this.send(target.socket, { t: 'leaveStream', from: self.info.id })
        break
      }
      case 'signal': {
        const target = this.peers().find((p) => p.data.info.id === msg.to)
        if (target) {
          this.send(target.socket, {
            t: 'signal',
            from: self.info.id,
            dir: msg.dir,
            payload: msg.payload
          })
        }
        break
      }
      case 'ping': {
        // Older clients still send the JSON keepalive; newer ones use the
        // literal 'ping' that the runtime auto-answers without waking us.
        this.send(socket, { t: 'pong', ts: msg.ts })
        break
      }
      case 'bye': {
        this.depart(socket, self)
        socket.close(1000, 'bye')
        break
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const self = socket.deserializeAttachment() as Attachment | null
    if (self) this.depart(socket, self)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const self = socket.deserializeAttachment() as Attachment | null
    if (self) this.depart(socket, self)
  }

  private depart(socket: WebSocket, self: Attachment): void {
    // Clearing the attachment is what makes this idempotent: an explicit
    // `bye` followed by the socket closing must not announce two departures.
    socket.serializeAttachment(null)
    this.broadcast({ t: 'peerLeft', id: self.info.id })
    this.report()
  }
}

/**
 * Mirante signaling server.
 *
 * Deliberately thin. It knows about rooms and who is in them, relays five
 * signaling verbs between peers, and mints short-lived TURN credentials.
 * Media never touches this process — that is the whole point of a mesh.
 *
 * Run: npm --prefix server run dev
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

import {
  PROTOCOL_VERSION,
  emptyPublishState,
  hueFromId,
  type ClientMessage,
  type PeerInfo,
  type PeerPublishState,
  type RoomId,
  type ServerMessage
} from '../../src/shared/protocol.ts'
import { describeIceConfig, readIceConfig, resolveIceServers } from './ice.ts'

const PORT = Number(process.env.PORT ?? 8787)

const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM ?? 8)

const iceConfig = readIceConfig(process.env)


// ---------------------------------------------------------------------------

interface Peer {
  info: PeerInfo
  state: PeerPublishState
  socket: WebSocket
  room: RoomId
  alive: boolean
  /** Stable across this client's reconnects, so a return replaces. */
  clientId: string
}

const rooms = new Map<RoomId, Map<string, Peer>>()

function roomOf(id: RoomId): Map<string, Peer> {
  let room = rooms.get(id)
  if (!room) {
    room = new Map()
    rooms.set(id, room)
  }
  return room
}

function send(peer: Peer, msg: ServerMessage): void {
  if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(msg))
}

function broadcast(room: Map<string, Peer>, msg: ServerMessage, exceptId?: string): void {
  for (const peer of room.values()) {
    if (peer.info.id !== exceptId) send(peer, msg)
  }
}

/** Normalise a room name so "Sala do Mirante" and "sala-do-mirante" are the same room. */
function normaliseRoom(raw: string): RoomId {
  return (
    raw
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'mirante'
  )
}

// ---------------------------------------------------------------------------

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health') {
    const peerCount = [...rooms.values()].reduce((n, r) => n + r.size, 0)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: peerCount }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http })

wss.on('connection', (socket: WebSocket) => {
  let peer: Peer | null = null

  socket.on('message', (raw: Buffer) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage
    } catch {
      return
    }

    // --- handshake ---------------------------------------------------------
    if (msg.t === 'hello') {
      if (peer) return
      if (msg.version !== PROTOCOL_VERSION) {
        socket.send(
          JSON.stringify({
            t: 'error',
            code: 'version_mismatch',
            message: `Servidor fala v${PROTOCOL_VERSION}, cliente fala v${msg.version}.`
          } satisfies ServerMessage)
        )
        socket.close()
        return
      }

      const roomId = normaliseRoom(msg.room)
      const room = roomOf(roomId)

      // Sweep corpses before counting. A socket can be half-dead for up to one
      // heartbeat, and until it is reaped its owner still occupies the room.
      for (const [id, existing] of room) {
        if (existing.socket.readyState > WebSocket.OPEN) {
          room.delete(id)
          broadcast(room, { t: 'peerLeft', id })
          console.log(`[room:${roomId}] ! swept ${existing.info.name}`)
        }
      }

      // A reconnecting client is the same person: replace, never duplicate.
      for (const [id, existing] of room) {
        if (existing.clientId !== msg.clientId) continue
        room.delete(id)
        broadcast(room, { t: 'peerLeft', id })
        existing.socket.close()
      }

      if (room.size >= MAX_PEERS_PER_ROOM) {
        socket.send(
          JSON.stringify({
            t: 'error',
            code: 'room_full',
            message: `Sala cheia (${MAX_PEERS_PER_ROOM}). Mesh P2P nao escala alem disso.`
          } satisfies ServerMessage)
        )
        socket.close()
        return
      }

      const id = randomUUID()
      const name = (msg.name || 'convidado').slice(0, 32)
      peer = {
        info: { id, name, hue: hueFromId(id), joinedAt: Date.now() },
        state: emptyPublishState(),
        socket,
        room: roomId,
        alive: true,
        clientId: msg.clientId
      }
      room.set(id, peer)

      const joining = peer
      // ICE resolution can hit the network (Cloudflare), so the welcome is
      // sent once credentials are in hand rather than blocking the socket.
      void resolveIceServers(iceConfig, id).then((iceServers) => {
        send(joining, {
          t: 'welcome',
          self: joining.info,
          peers: [...room.values()]
            .filter((p) => p.info.id !== id)
            .map((p) => ({ ...p.info, state: p.state })),
          iceServers
        })
      })
      broadcast(room, { t: 'peerJoined', peer: peer.info, state: peer.state }, id)
      console.log(`[room:${roomId}] + ${name} (${room.size})`)
      return
    }

    if (!peer) return
    const room = roomOf(peer.room)

    switch (msg.t) {
      case 'publishState': {
        peer.state = msg.state
        broadcast(room, { t: 'peerState', id: peer.info.id, state: msg.state }, peer.info.id)
        break
      }
      case 'join': {
        const target = room.get(msg.to)
        if (target) send(target, { t: 'join', from: peer.info.id })
        break
      }
      case 'leaveStream': {
        const target = room.get(msg.to)
        if (target) send(target, { t: 'leaveStream', from: peer.info.id })
        break
      }
      case 'signal': {
        const target = room.get(msg.to)
        if (target) {
          send(target, { t: 'signal', from: peer.info.id, dir: msg.dir, payload: msg.payload })
        }
        break
      }
      case 'ping': {
        send(peer, { t: 'pong', ts: msg.ts })
        break
      }
      case 'bye': {
        // Remove immediately rather than waiting for the socket to drop.
        room.delete(peer.info.id)
        broadcast(room, { t: 'peerLeft', id: peer.info.id })
        console.log(`[room:${peer.room}] - ${peer.info.name} (bye) (${room.size})`)
        if (room.size === 0) rooms.delete(peer.room)
        peer = null
        socket.close()
        break
      }
    }
  })

  socket.on('pong', () => {
    if (peer) peer.alive = true
  })

  socket.on('close', () => {
    if (!peer) return
    const room = roomOf(peer.room)
    room.delete(peer.info.id)
    broadcast(room, { t: 'peerLeft', id: peer.info.id })
    console.log(`[room:${peer.room}] - ${peer.info.name} (${room.size})`)
    if (room.size === 0) rooms.delete(peer.room)
    peer = null
  })
})

/** Drop sockets that stopped answering, so ghost peers do not linger on the rail. */
const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const peer of room.values()) {
      if (!peer.alive) {
        peer.socket.terminate()
        continue
      }
      peer.alive = false
      peer.socket.ping()
    }
  }
}, 15_000)

wss.on('close', () => clearInterval(heartbeat))

http.listen(PORT, () => {
  console.log(`Mirante signaling  ws://localhost:${PORT}`)
  for (const line of describeIceConfig(iceConfig)) console.log(line)
})

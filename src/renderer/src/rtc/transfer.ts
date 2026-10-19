import {
  CHUNK_BYTES,
  HIGH_WATER_BYTES,
  LOW_WATER_BYTES,
  MAX_FILES_PER_OFFER,
  MAX_INCOMING_SESSIONS,
  OFFER_TTL_MS,
  PACE_MS_WHEN_LIVE,
  PROGRESS_TICK_MS
} from '../../../shared/transfer'
import type {
  FileMeta,
  RTCIceServerConfig,
  SessionDescription,
  SignalPayload
} from '../../../shared/protocol'

export interface TransferTransport {
  send(to: string, payload: SignalPayload): void
  peers(): Array<{ id: string; name: string }>
  iceServers(): RTCIceServerConfig[]
  live(): boolean
}

export type IncomingState =
  | 'offered'
  | 'receiving'
  | 'saved'
  | 'failed'
  | 'denied'
  | 'cancelled'

export interface IncomingTransfer {
  id: string
  from: string
  fromName: string
  files: FileMeta[]
  state: IncomingState
  expiresAt: number | null
  bytes: number
  perFile: Record<string, number>
  paths: string[]
  hashes: Record<string, string>
  error: string | null
}

export type OutgoingState = 'offered' | 'sending' | 'sent' | 'expired' | 'failed' | 'cancelled'

export interface Recipient {
  peerId: string
  name: string
  state: 'sending' | 'sent' | 'failed'
  bytes: number
  total: number
  reason: string | null
}

export interface OutgoingTransfer {
  id: string
  files: FileMeta[]
  state: OutgoingState
  expiresAt: number | null
  recipients: Recipient[]
  error: string | null
}

export interface TransferSnapshot {
  incoming: IncomingTransfer[]
  outgoing: OutgoingTransfer[]
}

type ControlFrame =
  | { t: 'begin'; fileId: string }
  | { t: 'end'; fileId: string }
  | { t: 'progress'; fileId: string; bytes: number }
  | { t: 'saved'; hashes: Record<string, string> }
  | { t: 'failed'; reason: string }

interface Link {
  pc: RTCPeerConnection
  channel: RTCDataChannel | null
  queued: RTCIceCandidateInit[]
}

const KEEP_ENTRIES = 12

const CLOSED_STATES = new Set([
  'saved',
  'failed',
  'denied',
  'cancelled',
  'sent',
  'expired'
])

const keyOf = (session: string, peerId: string): string => `${session}|${peerId}`

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function waitForRoom(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      channel.removeEventListener('bufferedamountlow', done)
      channel.removeEventListener('close', done)
      resolve()
    }
    channel.addEventListener('bufferedamountlow', done)
    channel.addEventListener('close', done)
  })
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TransferManager {
  private readonly incoming: IncomingTransfer[] = []
  private readonly outgoing: OutgoingTransfer[] = []
  private readonly links = new Map<string, Link>()
  private readonly early = new Map<string, RTCIceCandidateInit[]>()
  private readonly blobs = new Map<string, Map<string, File>>()
  private readonly offerTargets = new Map<string, Set<string>>()
  private readonly tokens = new Map<string, string>()
  private readonly currentFile = new Map<string, string>()
  private readonly rxChain = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, number>()

  private snapshot: TransferSnapshot = { incoming: [], outgoing: [] }
  private listeners = new Set<() => void>()
  private lastEmit = 0

  constructor(private readonly transport: TransferTransport) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): TransferSnapshot => this.snapshot

  private emit(): void {
    this.lastEmit = Date.now()
    this.snapshot = { incoming: [...this.incoming], outgoing: [...this.outgoing] }
    for (const listener of this.listeners) listener()
  }

  private emitSoon(): void {
    if (Date.now() - this.lastEmit >= PROGRESS_TICK_MS) this.emit()
  }

  private arm(key: string, fn: () => void, ms: number): void {
    this.disarm(key)
    this.timers.set(key, window.setTimeout(() => this.timers.delete(key) && fn(), ms))
  }

  private disarm(key: string): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  private prune(list: Array<{ state: string }>): void {
    while (list.length > KEEP_ENTRIES) {
      const index = list.findIndex((entry) => CLOSED_STATES.has(entry.state))
      if (index < 0) return
      list.splice(index, 1)
    }
  }

  offer(files: File[]): void {
    const peers = this.transport.peers()
    if (peers.length === 0) return

    const refs: FileMeta[] = []
    const batch = new Map<string, File>()
    for (const file of files) {
      if (refs.length >= MAX_FILES_PER_OFFER) break
      if (!Number.isSafeInteger(file.size) || file.size < 0) continue
      const id = crypto.randomUUID()
      refs.push({
        id,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream'
      })
      batch.set(id, file)
    }
    if (refs.length === 0) return

    const session = crypto.randomUUID()
    const entry: OutgoingTransfer = {
      id: session,
      files: refs,
      state: 'offered',
      expiresAt: Date.now() + OFFER_TTL_MS,
      recipients: [],
      error: null
    }
    this.outgoing.push(entry)
    this.blobs.set(session, batch)
    this.offerTargets.set(
      session,
      new Set(peers.map((peer) => peer.id))
    )
    this.prune(this.outgoing)
    this.arm(`out:${session}`, () => this.expireOutgoing(session), OFFER_TTL_MS)

    const payload: SignalPayload = { cmd: 'fileOffer', session, files: refs, ttlMs: OFFER_TTL_MS }
    for (const peer of peers) this.transport.send(peer.id, payload)
    this.emit()
  }

  retry(session: string): void {
    const batch = this.blobs.get(session)
    if (!batch) return
    this.offer([...batch.values()])
  }

  private expireOutgoing(session: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry) return
    if (entry.state === 'offered') entry.state = 'expired'
    entry.expiresAt = null
    this.emit()
  }

  cancelOutgoing(session: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry) return
    this.disarm(`out:${session}`)
    entry.expiresAt = null
    if (!CLOSED_STATES.has(entry.state)) entry.state = 'cancelled'
    for (const recipient of entry.recipients) {
      if (recipient.state !== 'sending') continue
      recipient.state = 'failed'
      recipient.reason = 'cancelado'
      this.closeLink(keyOf(session, recipient.peerId))
      this.transport.send(recipient.peerId, { cmd: 'fileCancel', session })
    }
    this.emit()
  }

  async accept(session: string): Promise<void> {
    const entry = this.incoming.find(
      (transfer) => transfer.id === session && transfer.state === 'offered'
    )
    if (!entry) return
    if (entry.expiresAt === null || Date.now() >= entry.expiresAt) return
    this.disarm(`in:${session}`)

    const api = window.mirante.transfer
    if (!api) {
      await this.failIncoming(session, 'sem acesso ao disco')
      this.transport.send(entry.from, { cmd: 'fileDeny', session, reason: 'falhou' })
      return
    }

    this.transport.send(entry.from, { cmd: 'fileAccept', session })
    try {
      const { token, targets } = await api.open(
        entry.files.map((file) => ({ fileId: file.id, name: file.name, size: file.size }))
      )
      if (entry.state !== 'offered') return
      this.tokens.set(session, token)
      entry.paths = targets.map((target) => target.path)
      entry.files = entry.files.map((file) => ({
        ...file,
        name: targets.find((target) => target.fileId === file.id)?.name ?? file.name
      }))
      entry.perFile = Object.fromEntries(entry.files.map((file) => [file.id, 0]))
      entry.expiresAt = null
      entry.state = 'receiving'
      this.emit()
      await this.connectAsOfferer(entry)
    } catch (error) {
      this.failIncoming(session, reasonOf(error))
      this.transport.send(entry.from, { cmd: 'fileDeny', session, reason: 'falhou' })
    }
  }

  deny(session: string, reason = 'recusou'): void {
    const entry = this.incoming.find(
      (transfer) => transfer.id === session && transfer.state === 'offered'
    )
    if (!entry) return
    this.disarm(`in:${session}`)
    entry.state = 'denied'
    entry.expiresAt = null
    this.transport.send(entry.from, { cmd: 'fileDeny', session, reason })
    this.emit()
  }

  cancelIncoming(session: string): void {
    const entry = this.incoming.find((transfer) => transfer.id === session)
    if (!entry) return
    if (entry.state === 'receiving') {
      entry.state = 'cancelled'
      entry.expiresAt = null
      void this.releaseSink(session)
      this.closeLink(keyOf(session, entry.from))
      this.transport.send(entry.from, { cmd: 'fileCancel', session })
      this.emit()
    } else if (entry.state === 'offered') {
      this.deny(session, 'cancelado')
    }
  }

  private expireIncoming(session: string): void {
    const index = this.incoming.findIndex((transfer) => transfer.id === session)
    if (index < 0) return
    if (this.incoming[index].state === 'offered') this.incoming.splice(index, 1)
    this.emit()
  }

  async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    switch (payload.cmd) {
      case 'fileOffer':
        this.onOffer(from, payload.session, payload.files, payload.ttlMs)
        return
      case 'fileAccept':
        this.onAccept(from, payload.session)
        return
      case 'fileDeny':
        this.onDeny(from, payload.session, payload.reason)
        return
      case 'fileCancel':
        this.onCancel(from, payload.session)
        return
      case 'filePcOffer':
        await this.onPcOffer(from, payload.session, payload.offer)
        return
      case 'filePcAnswer':
        this.onPcAnswer(from, payload.session, payload.answer)
        return
      case 'fileIce':
        this.addCandidate(from, payload.session, payload.candidate)
        return
      default:
        return
    }
  }

  private onOffer(
    from: string,
    session: string,
    files: FileMeta[],
    ttlMs: number
  ): void {
    if (!this.transport.peers().some((peer) => peer.id === from)) return
    if (this.incoming.some((transfer) => transfer.id === session)) return
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES_PER_OFFER) return
    const valid = files.every(
      (file) =>
        file &&
        typeof file.id === 'string' &&
        typeof file.name === 'string' &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0
    )
    if (!valid) return
    if (this.incoming.filter((transfer) => transfer.state === 'receiving').length >= MAX_INCOMING_SESSIONS) {
      this.transport.send(from, { cmd: 'fileDeny', session, reason: 'ocupado' })
      return
    }

    const ttl = Number.isFinite(ttlMs)
      ? Math.min(Math.max(ttlMs, 1_000), OFFER_TTL_MS)
      : OFFER_TTL_MS
    const entry: IncomingTransfer = {
      id: session,
      from,
      fromName: this.transport.peers().find((peer) => peer.id === from)?.name ?? from,
      files: [...files],
      state: 'offered',
      expiresAt: Date.now() + ttl,
      bytes: 0,
      perFile: {},
      paths: [],
      hashes: {},
      error: null
    }
    this.incoming.push(entry)
    this.prune(this.incoming)
    this.arm(`in:${session}`, () => this.expireIncoming(session), ttl)
    this.emit()
  }

  private onAccept(from: string, session: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry || !this.mayReceive(entry, from)) {
      this.transport.send(from, { cmd: 'fileDeny', session, reason: 'expirado' })
      return
    }
    this.markAccepting(entry, from)
    this.emit()
  }

  private onDeny(from: string, session: string, reason: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry) return
    const recipient =
      entry.recipients.find((other) => other.peerId === from) ??
      this.pushRecipient(entry, from, 'failed')
    recipient.state = 'failed'
    recipient.reason = reason || 'recusou'
    this.finishOutgoing(session)
    this.emit()
  }

  private onCancel(from: string, session: string): void {
    const out = this.outgoing.find((transfer) => transfer.id === session)
    if (out) {
      const recipient = out.recipients.find((other) => other.peerId === from)
      if (recipient && recipient.state === 'sending') {
        recipient.state = 'failed'
        recipient.reason = 'cancelado'
        this.closeLink(keyOf(session, from))
        this.finishOutgoing(session)
        this.emit()
      }
      return
    }
    const inc = this.incoming.find(
      (transfer) => transfer.id === session && transfer.from === from
    )
    if (!inc) return
    if (inc.state === 'receiving') {
      inc.state = 'cancelled'
      inc.error = 'cancelado pelo remetente'
      inc.expiresAt = null
      void this.releaseSink(session)
      this.closeLink(keyOf(session, from))
      this.emit()
    } else if (inc.state === 'offered') {
      this.expireIncoming(session)
    }
  }

  private async onPcOffer(
    from: string,
    session: string,
    offer: SessionDescription
  ): Promise<void> {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry || !this.mayReceive(entry, from)) {
      this.transport.send(from, { cmd: 'fileDeny', session, reason: 'expirado' })
      return
    }
    this.markAccepting(entry, from)
    this.emit()

    const key = keyOf(session, from)
    this.closeLink(key)
    const pc = new RTCPeerConnection({
      iceServers: this.transport.iceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })
    const link: Link = { pc, channel: null, queued: [] }
    this.links.set(key, link)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.transport.send(from, {
          cmd: 'fileIce',
          session,
          candidate: event.candidate.toJSON()
        })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.failRecipient(session, from, 'conexão falhou')
    }
    pc.ondatachannel = (event) => {
      link.channel = event.channel
      event.channel.bufferedAmountLowThreshold = LOW_WATER_BYTES
      this.wireSender(event.channel, session, from)
    }

    try {
      await pc.setRemoteDescription(offer)
      await this.flush(link, key)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.transport.send(from, { cmd: 'filePcAnswer', session, answer })
    } catch (error) {
      this.failRecipient(session, from, reasonOf(error))
      this.closeLink(key)
    }
  }

  private onPcAnswer(from: string, session: string, answer: SessionDescription): void {
    const key = keyOf(session, from)
    const link = this.links.get(key)
    if (!link) return
    void link.pc
      .setRemoteDescription(answer)
      .then(() => this.flush(link, key))
      .catch((error) => this.failIncoming(session, reasonOf(error)))
  }

  private async addCandidate(
    from: string,
    session: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    const key = keyOf(session, from)
    const link = this.links.get(key)
    if (!link) {
      const queue = this.early.get(key) ?? []
      queue.push(candidate)
      this.early.set(key, queue)
      return
    }
    if (!link.pc.remoteDescription) {
      link.queued.push(candidate)
      return
    }
    try {
      await link.pc.addIceCandidate(candidate)
    } catch {
    }
  }

  private async flush(link: Link, key: string): Promise<void> {
    for (const candidate of link.queued.splice(0)) {
      try {
        await link.pc.addIceCandidate(candidate)
      } catch {
      }
    }
    for (const candidate of this.early.get(key) ?? []) {
      try {
        await link.pc.addIceCandidate(candidate)
      } catch {
      }
    }
    this.early.delete(key)
  }

  private async connectAsOfferer(entry: IncomingTransfer): Promise<void> {
    const key = keyOf(entry.id, entry.from)
    this.closeLink(key)
    const pc = new RTCPeerConnection({
      iceServers: this.transport.iceServers(),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })
    const link: Link = { pc, channel: null, queued: [] }
    this.links.set(key, link)

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.transport.send(entry.from, {
          cmd: 'fileIce',
          session: entry.id,
          candidate: event.candidate.toJSON()
        })
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.failIncoming(entry.id, 'conexão falhou')
    }

    const channel = pc.createDataChannel(entry.id)
    link.channel = channel
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES
    this.wireReceiver(channel, entry.id)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.transport.send(entry.from, { cmd: 'filePcOffer', session: entry.id, offer })
  }

  private wireReceiver(channel: RTCDataChannel, session: string): void {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => {
      const previous = this.rxChain.get(session) ?? Promise.resolve()
      this.rxChain.set(
        session,
        previous
          .then(() => this.onFrame(session, event.data))
          .catch((error) => this.failIncoming(session, reasonOf(error)))
      )
    }
    channel.onclose = () => {
      const entry = this.incoming.find((transfer) => transfer.id === session)
      if (entry?.state === 'receiving') this.failIncoming(session, 'conexão encerrada')
    }
  }

  private async onFrame(session: string, data: unknown): Promise<void> {
    const entry = this.incoming.find((transfer) => transfer.id === session)
    if (!entry || entry.state !== 'receiving') return
    const api = window.mirante.transfer

    if (typeof data === 'string') {
      let frame: ControlFrame
      try {
        frame = JSON.parse(data) as ControlFrame
      } catch {
        return
      }
      switch (frame.t) {
        case 'begin': {
          if (!(frame.fileId in entry.perFile)) throw new Error('arquivo desconhecido')
          this.currentFile.set(session, frame.fileId)
          return
        }
        case 'end': {
          const fileId = this.currentFile.get(session)
          if (!fileId || fileId !== frame.fileId) throw new Error('ordem de arquivo inesperada')
          const expected = entry.files.find((file) => file.id === fileId)?.size ?? -1
          if (entry.perFile[fileId] !== expected) throw new Error('arquivo chegou incompleto')
          this.currentFile.delete(session)
          await this.finishIncoming(session)
          return
        }
        case 'failed': {
          this.failIncoming(session, frame.reason || 'falhou do outro lado')
          return
        }
        default:
          return
      }
    }

    if (!(data instanceof ArrayBuffer)) return
    const fileId = this.currentFile.get(session)
    if (!fileId) throw new Error('pedaço sem arquivo')
    const file = entry.files.find((other) => other.id === fileId)
    if (!file || !api) return
    if (entry.perFile[fileId] + data.byteLength > file.size) {
      throw new Error('excede o tamanho anunciado')
    }

    entry.perFile[fileId] += data.byteLength
    entry.bytes += data.byteLength
    const result = await api.write(this.tokens.get(session) ?? '', fileId, data)
    if (result.error) throw new Error(result.error)

    if (Date.now() - this.lastEmit >= PROGRESS_TICK_MS) {
      this.emit()
      this.links
        .get(keyOf(session, entry.from))
        ?.channel?.send(
          JSON.stringify({ t: 'progress', fileId, bytes: entry.perFile[fileId] } satisfies ControlFrame)
        )
    }
  }

  private async finishIncoming(session: string): Promise<void> {
    const entry = this.incoming.find((transfer) => transfer.id === session)
    const api = window.mirante.transfer
    if (!entry || entry.state !== 'receiving' || !api) return

    const result = await api.close(this.tokens.get(session) ?? '')
    this.tokens.delete(session)
    if (result.error || result.paths.length !== entry.files.length) {
      throw new Error(result.error || 'nem todos os arquivos chegaram')
    }
    entry.paths = result.paths
    entry.hashes = result.hashes
    entry.state = 'saved'
    this.currentFile.delete(session)
    this.emit()
    const channel = this.links.get(keyOf(session, entry.from))?.channel
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify({ t: 'saved', hashes: result.hashes } satisfies ControlFrame))
    }
    this.closeLink(keyOf(session, entry.from))
  }

  private async failIncoming(session: string, reason: string): Promise<void> {
    const entry = this.incoming.find((transfer) => transfer.id === session)
    if (!entry || CLOSED_STATES.has(entry.state)) return
    entry.state = 'failed'
    entry.error = reason
    entry.expiresAt = null
    this.disarm(`in:${session}`)
    this.currentFile.delete(session)
    this.closeLink(keyOf(session, entry.from))
    await this.releaseSink(session)
    this.emit()
  }

  private async releaseSink(session: string): Promise<void> {
    const token = this.tokens.get(session)
    if (!token) return
    this.tokens.delete(session)
    await window.mirante.transfer?.cancel(token)
  }

  private closeLink(key: string): void {
    const link = this.links.get(key)
    if (!link) return
    this.links.delete(key)
    link.channel?.close()
    link.pc.close()
  }

  private mayReceive(entry: OutgoingTransfer, from: string): boolean {
    if (CLOSED_STATES.has(entry.state)) return false
    if (!this.offerTargets.get(entry.id)?.has(from)) return false
    if (entry.recipients.some((recipient) => recipient.peerId === from)) return true
    return entry.expiresAt !== null && Date.now() < entry.expiresAt
  }

  private markAccepting(entry: OutgoingTransfer, from: string): void {
    const recipient =
      entry.recipients.find((other) => other.peerId === from) ??
      this.pushRecipient(entry, from, 'sending')
    recipient.state = 'sending'
    recipient.reason = null
    entry.state = 'sending'
    this.disarm(`out:${entry.id}`)
  }

  private pushRecipient(
    entry: OutgoingTransfer,
    peerId: string,
    state: Recipient['state']
  ): Recipient {
    const recipient: Recipient = {
      peerId,
      name: this.transport.peers().find((peer) => peer.id === peerId)?.name ?? peerId,
      state,
      bytes: 0,
      total: entry.files.reduce((sum, file) => sum + file.size, 0),
      reason: null
    }
    entry.recipients.push(recipient)
    return recipient
  }

  private finishOutgoing(session: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry || entry.recipients.length === 0) return
    if (entry.recipients.some((recipient) => recipient.state === 'sending')) return
    entry.state = entry.recipients.some((recipient) => recipient.state === 'sent') ? 'sent' : 'failed'
    entry.expiresAt = null
  }

  private failRecipient(session: string, peerId: string, reason: string): void {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    if (!entry) return
    const recipient =
      entry.recipients.find((other) => other.peerId === peerId) ??
      this.pushRecipient(entry, peerId, 'failed')
    if (recipient.state === 'sent') return
    recipient.state = 'failed'
    recipient.reason = reason
    this.closeLink(keyOf(session, peerId))
    this.finishOutgoing(session)
    this.emit()
  }

  private wireSender(channel: RTCDataChannel, session: string, peerId: string): void {
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let frame: ControlFrame
      try {
        frame = JSON.parse(event.data) as ControlFrame
      } catch {
        return
      }
      const entry = this.outgoing.find((transfer) => transfer.id === session)
      const recipient = entry?.recipients.find((other) => other.peerId === peerId)
      if (!entry || !recipient) return
      if (frame.t === 'progress') {
        recipient.bytes = Math.max(recipient.bytes, frame.bytes)
        this.emitSoon()
      } else if (frame.t === 'saved') {
        recipient.state = 'sent'
        recipient.bytes = recipient.total
        this.closeLink(keyOf(session, peerId))
        this.finishOutgoing(session)
        this.emit()
      } else if (frame.t === 'failed') {
        this.failRecipient(session, peerId, frame.reason || 'falhou do outro lado')
      }
    }
    channel.onclose = () => {
      const entry = this.outgoing.find((transfer) => transfer.id === session)
      const recipient = entry?.recipients.find((other) => other.peerId === peerId)
      if (recipient?.state === 'sending') this.failRecipient(session, peerId, 'conexão encerrada')
    }
    if (channel.readyState === 'open') void this.pump(session, peerId, channel)
    else channel.onopen = () => void this.pump(session, peerId, channel)
  }

  private async pump(session: string, peerId: string, channel: RTCDataChannel): Promise<void> {
    const entry = this.outgoing.find((transfer) => transfer.id === session)
    const batch = this.blobs.get(session)
    const recipient = entry?.recipients.find((other) => other.peerId === peerId)
    if (!entry || !batch || !recipient) return

    try {
      for (const meta of entry.files) {
        if (entry.state !== 'sending' || recipient.state !== 'sending') return
        const file = batch.get(meta.id)
        if (!file) throw new Error('arquivo sumiu')
        channel.send(JSON.stringify({ t: 'begin', fileId: meta.id } satisfies ControlFrame))
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
          if (channel.readyState !== 'open' || recipient.state !== 'sending') return
          if (channel.bufferedAmount > HIGH_WATER_BYTES) await waitForRoom(channel)
          channel.send(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
          if (this.transport.live()) await delay(PACE_MS_WHEN_LIVE)
        }
        channel.send(JSON.stringify({ t: 'end', fileId: meta.id } satisfies ControlFrame))
      }
    } catch (error) {
      this.failRecipient(session, peerId, reasonOf(error))
      this.transport.send(peerId, { cmd: 'fileCancel', session })
    }
  }

  dropPeer(peerId: string): void {
    let changed = false
    for (const entry of [...this.incoming]) {
      if (entry.from !== peerId) continue
      changed = true
      this.disarm(`in:${entry.id}`)
      if (entry.state === 'offered') {
        this.incoming.splice(this.incoming.indexOf(entry), 1)
      } else if (entry.state === 'receiving') {
        entry.state = 'failed'
        entry.error = 'saiu da sala'
        void this.releaseSink(entry.id)
      }
      this.closeLink(keyOf(entry.id, peerId))
    }
    for (const entry of this.outgoing) {
      for (const recipient of entry.recipients) {
        if (recipient.peerId !== peerId || recipient.state !== 'sending') continue
        recipient.state = 'failed'
        recipient.reason = 'saiu da sala'
        this.closeLink(keyOf(entry.id, peerId))
        this.finishOutgoing(entry.id)
        changed = true
      }
    }
    if (changed) this.emit()
  }

  closeAll(): void {
    for (const key of [...this.links.keys()]) this.closeLink(key)
    for (const timer of this.timers.values()) window.clearTimeout(timer)
    this.timers.clear()
    this.early.clear()
    this.currentFile.clear()
    this.rxChain.clear()
    for (const entry of this.incoming) {
      this.disarm(`in:${entry.id}`)
      if (entry.state === 'receiving') {
        entry.state = 'failed'
        entry.error = 'desconectado'
        void this.releaseSink(entry.id)
      } else if (entry.state === 'offered') {
        entry.state = 'denied'
      }
      entry.expiresAt = null
    }
    for (const entry of this.outgoing) {
      this.disarm(`out:${entry.id}`)
      entry.expiresAt = null
      for (const recipient of entry.recipients) {
        if (recipient.state === 'sending') {
          recipient.state = 'failed'
          recipient.reason = 'desconectado'
        }
      }
      this.finishOutgoing(entry.id)
      if (entry.state === 'offered') entry.state = 'expired'
    }
    this.emit()
  }
}

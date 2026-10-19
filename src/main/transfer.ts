import { randomUUID, createHash, type Hash } from 'node:crypto'
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { app, ipcMain, shell } from 'electron'

import {
  MAX_FILES_PER_OFFER,
  dedupeName,
  sanitizeName,
  type TransferCloseResult,
  type TransferFileRef,
  type TransferOpenResult,
  type TransferWriteResult
} from '../shared/transfer'

function downloadsDir(): string {
  return app.getPath('downloads')
}

interface SinkFile {
  stream: WriteStream
  path: string
  partPath: string
  hash: Hash
  bytes: number
  size: number
}

interface Sink {
  files: Map<string, SinkFile>
}

const sinks = new Map<string, Sink>()

async function discard(files: Iterable<SinkFile>): Promise<void> {
  for (const file of files) {
    file.stream.destroy()
    await fs.unlink(file.partPath).catch(() => {})
  }
}

export function registerTransferIpc(): void {
  ipcMain.handle(
    'transfer:open',
    async (_event, refs: TransferFileRef[]): Promise<TransferOpenResult> => {
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_FILES_PER_OFFER) {
        throw new Error('lista de arquivos inválida')
      }
      for (const ref of refs) {
        if (!ref || typeof ref.fileId !== 'string' || !ref.fileId) throw new Error('arquivo sem id')
        if (typeof ref.name !== 'string') throw new Error('arquivo sem nome')
        if (!Number.isSafeInteger(ref.size) || ref.size < 0) throw new Error('tamanho inválido')
      }

      const dir = downloadsDir()
      await fs.mkdir(dir, { recursive: true })

      const taken = new Set<string>()
      try {
        for (const entry of await fs.readdir(dir)) taken.add(entry.toLowerCase())
      } catch {
      }

      const token = randomUUID()
      const sink: Sink = { files: new Map() }
      const opened: SinkFile[] = []
      const targets: TransferOpenResult['targets'] = []

      try {
        for (const ref of refs) {
          const name = dedupeName(sanitizeName(ref.name), taken)
          taken.add(name.toLowerCase())
          const path = resolve(dir, name)
          if (!path.startsWith(dir + sep)) throw new Error('caminho fora de Downloads')
          const partPath = join(dir, `.${name}.part`)
          const stream = createWriteStream(partPath, { flags: 'w' })
          const file: SinkFile = {
            stream,
            path,
            partPath,
            hash: createHash('sha256'),
            bytes: 0,
            size: ref.size
          }
          stream.on('error', () => {
            sink.files.delete(ref.fileId)
            void fs.unlink(partPath).catch(() => {})
          })
          sink.files.set(ref.fileId, file)
          opened.push(file)
          targets.push({ fileId: ref.fileId, path, name, size: ref.size })
        }
      } catch (error) {
        await discard(opened)
        throw error
      }

      sinks.set(token, sink)
      return { token, targets }
    }
  )

  ipcMain.handle(
    'transfer:write',
    async (
      _event,
      token: string,
      fileId: string,
      chunk: ArrayBuffer
    ): Promise<TransferWriteResult> => {
      const file = sinks.get(token)?.files.get(fileId)
      if (!file) return { error: 'destino desconhecido' }
      const buffer = Buffer.from(chunk)
      if (file.bytes + buffer.length > file.size) return { error: 'excede o tamanho anunciado' }

      file.hash.update(buffer)
      file.bytes += buffer.length
      await new Promise<void>((done) => {
        const finish = (): void => {
          file.stream.off('drain', finish)
          file.stream.off('error', finish)
          done()
        }
        if (file.stream.write(buffer)) done()
        else {
          file.stream.once('drain', finish)
          file.stream.once('error', finish)
        }
      })
      return {}
    }
  )

  ipcMain.handle(
    'transfer:close',
    async (_event, token: string): Promise<TransferCloseResult> => {
      const sink = sinks.get(token)
      if (!sink) return { paths: [], hashes: {}, error: 'sessão desconhecida' }
      sinks.delete(token)

      const paths: string[] = []
      const hashes: Record<string, string> = {}
      const errors: string[] = []

      for (const [fileId, file] of sink.files) {
        await new Promise<void>((done) => {
          if (file.stream.destroyed) return done()
          file.stream.once('error', () => done())
          file.stream.end(done)
        })
        if (file.bytes !== file.size) {
          await fs.unlink(file.partPath).catch(() => {})
          errors.push(`${file.path}: chegou incompleto`)
          continue
        }
        try {
          await fs.rename(file.partPath, file.path)
          paths.push(file.path)
          hashes[fileId] = file.hash.digest('hex')
        } catch {
          await fs.unlink(file.partPath).catch(() => {})
          errors.push(`${file.path}: não foi possível gravar`)
        }
      }

      return { paths, hashes, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) }
    }
  )

  ipcMain.handle('transfer:cancel', async (_event, token: string) => {
    const sink = sinks.get(token)
    if (!sink) return
    sinks.delete(token)
    await discard(sink.files.values())
  })

  ipcMain.handle('transfer:reveal', (_event, path: string) => {
    if (typeof path !== 'string' || !path) return
    const dir = downloadsDir()
    const target = resolve(path)
    if (!target.startsWith(dir + sep)) return
    shell.showItemInFolder(target)
  })
}

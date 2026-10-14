/**
 * Rasterises the Tv Mirante lighthouse into build/icon.ico (and PNGs).
 *
 * No image dependency: the mark is pure polygons, so we scan-convert them
 * ourselves with 4x supersampling for antialiasing, deflate with node's zlib,
 * and pack PNGs into an ICO container (Vista+ reads PNG-in-ICO directly).
 *
 * The geometry is copied from src/renderer/src/components/logo.tsx — if you
 * change one, change both. It is twelve numbers; a shared format would cost
 * more than it saves.
 *
 * Run: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'build')

/** Design-space canvas, matching the SVG viewBox. */
const VIEW = 24

/** Near-black violet plate, matching --surface-base. */
const PLATE = [9, 7, 14]
/** Lilac, matching --accent at hsl(263 88% 72%). */
const ACCENT = [179, 140, 248]

const SHAPES = [
  // Geometry mirrors logo.tsx exactly. Twelve numbers; a shared format would
  // cost more than it saves — but change one, change both.
  { points: [[8.8, 5.6], [1.2, 3.1], [1.2, 5.0], [8.8, 7.4]], alpha: 0.4 },
  { points: [[15.2, 5.6], [22.8, 3.1], [22.8, 5.0], [15.2, 7.4]], alpha: 0.4 },
  { points: [[10.2, 4.2], [13.8, 4.2], [13.8, 9], [10.2, 9]], alpha: 1 },
  { points: [[8.6, 9], [15.4, 9], [15.4, 10.6], [8.6, 10.6]], alpha: 0.9 },
  { points: [[9.9, 10.6], [14.1, 10.6], [15.9, 21.4], [8.1, 21.4]], alpha: 0.72 },
  { points: [[6, 21.4], [18, 21.4], [18, 23.6], [6, 23.6]], alpha: 1 }
]

const SIZES = [16, 24, 32, 48, 64, 128, 256]

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Standard even-odd crossing test. */
function inside(points, x, y) {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

const SUPERSAMPLE = 4

/** Returns RGBA bytes for one square icon size. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const scale = size / VIEW
  const step = 1 / SUPERSAMPLE
  const offset = step / 2

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Start from the opaque plate; the mark composites over it.
      let r = PLATE[0]
      let g = PLATE[1]
      let b = PLATE[2]

      for (const shape of SHAPES) {
        let covered = 0
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const x = (px + offset + sx * step) / scale
            const y = (py + offset + sy * step) / scale
            if (inside(shape.points, x, y)) covered++
          }
        }
        if (covered === 0) continue

        const a = (covered / (SUPERSAMPLE * SUPERSAMPLE)) * shape.alpha
        r = Math.round(r * (1 - a) + ACCENT[0] * a)
        g = Math.round(g * (1 - a) + ACCENT[1] * a)
        b = Math.round(b * (1 - a) + ACCENT[2] * a)
      }

      const i = (py * size + px) * 4
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = 255
    }
  }
  return pixels
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function toPng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0 // deflate
  header[11] = 0 // adaptive filtering
  header[12] = 0 // no interlace

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// ICO
// ---------------------------------------------------------------------------

function toIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length

  entries.forEach((entry, index) => {
    const at = index * 16
    // 256 is encoded as 0 in the single-byte dimension fields.
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // palette size
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32BE(0, at + 8)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)])
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })

const entries = SIZES.map((size) => ({ size, png: toPng(size, render(size)) }))

writeFileSync(join(OUT_DIR, 'icon.ico'), toIco(entries))
// electron-builder also likes a 512 PNG around for non-Windows targets.
writeFileSync(join(OUT_DIR, 'icon.png'), toPng(512, render(512)))

console.log(`build/icon.ico  ${SIZES.join(', ')}px`)
console.log('build/icon.png  512px')

import assert from 'node:assert/strict'

import { CHUNK_BYTES, chunkCount, dedupeName, sanitizeName } from '../src/shared/transfer.ts'

assert.equal(sanitizeName('relatorio.pdf'), 'relatorio.pdf')
assert.equal(sanitizeName('..\\..\\Windows\\System32\\evil.exe'), 'evil.exe')
assert.equal(sanitizeName('C:/Users/gabry/../../etc/passwd'), 'passwd')
assert.equal(sanitizeName('   '), 'arquivo')
assert.equal(sanitizeName('...hidden'), 'hidden')
assert.equal(sanitizeName('a\x00b.txt'), 'ab.txt')
assert.equal(sanitizeName('a:b*c?.txt'), 'a_b_c_.txt')
assert.equal(sanitizeName('../../x'.repeat(60) + '.bin').length <= 120, true)

assert.equal(dedupeName('foto.png', new Set()), 'foto.png')
assert.equal(dedupeName('foto.png', new Set(['foto.png'])), 'foto (1).png')
assert.equal(dedupeName('foto.png', new Set(['foto.png', 'foto (1).png'])), 'foto (2).png')
assert.equal(dedupeName('sem-extensao', new Set(['sem-extensao'])), 'sem-extensao (1)')
assert.equal(dedupeName('.bashrc', new Set(['.bashrc'])), '.bashrc (1)')

assert.equal(chunkCount(0), 0)
assert.equal(chunkCount(1), 1)
assert.equal(chunkCount(CHUNK_BYTES), 1)
assert.equal(chunkCount(CHUNK_BYTES + 1), 2)
assert.equal(chunkCount(8 * 1024 * 1024), 128)

console.log('transfer-check: ok')

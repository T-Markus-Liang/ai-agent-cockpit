#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// Run with the bridge stopped. Preserve available legacy turns verbatim, and
// seed a durable outbox without doubling the bridge's recent context.
const config = JSON.parse(await fs.readFile(new URL('../config/wechat-acp.json', import.meta.url), 'utf8'))
const file = process.env.WECHAT_MEMORY_FILE ?? path.join(os.homedir(), '.wechat-acp/instances/cezar-codex/conversation-memory.json')
const state = JSON.parse(await fs.readFile(file, 'utf8'))
if (state.version !== 1 || !state.users) throw new Error('unsupported conversation memory version')
const backup = `${file}.before-mem0`
await fs.copyFile(file, backup, fs.constants?.COPYFILE_EXCL ?? 1).catch(error => { if (error.code !== 'EEXIST') throw error })
await fs.chmod(backup, 0o600)
const archiveDir = path.join(path.dirname(file), 'conversation-archive')
await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 })
let archived = 0, queued = 0
state.outbox ??= []
for (const [id, memory] of Object.entries(state.users)) {
  const userId = `wechat-${crypto.createHash('sha256').update(id).digest('hex')}`
  const archive = path.join(archiveDir, `${userId}.jsonl`)
  const existing = await fs.readFile(archive, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '' })
  const seen = new Set(existing.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).id))
  const events = memory.turns.map((turn, index) => ({ id: `legacy-${crypto.createHash('sha256').update(JSON.stringify([userId, index, turn])).digest('hex')}`, userId, ...turn }))
  for (const event of events) {
    if (!seen.has(event.id)) { await fs.appendFile(archive, JSON.stringify(event) + '\n', { mode: 0o600 }); archived++ }
    if (!state.outbox.some(item => item.id === event.id)) { state.outbox.push(event); queued++ }
  }
}
const temporary = `${file}.${crypto.randomUUID()}.tmp`
await fs.writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 })
await fs.rename(temporary, file)
console.log(JSON.stringify({ type: 'Mem0LegacyMigration', archived, queued, memoryBackend: config.memory.mem0.url, backupCreated: true, originalRecentContextPreserved: true }))

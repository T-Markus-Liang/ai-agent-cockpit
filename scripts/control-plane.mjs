#!/usr/bin/env node
import { indexLocalSessions } from '../control-plane/session-index.mjs'

const args = process.argv.slice(2)
const command = args[0] ?? 'sessions'
const subcommand = args[1] ?? 'list'
const json = args.includes('--json')
const providerArg = args.find((arg) => arg.startsWith('--provider='))
const cwdArg = args.find((arg) => arg.startsWith('--cwd='))
const limitArg = args.find((arg) => arg.startsWith('--limit='))

if (command !== 'sessions' || subcommand !== 'list') {
  console.error('用法：node scripts/control-plane.mjs sessions list [--json] [--provider=<id>] [--cwd=<path>] [--limit=<n>]')
  process.exit(2)
}

const snapshot = await indexLocalSessions({
  providers: providerArg ? [providerArg.slice('--provider='.length)] : undefined,
  limit: limitArg ? Number(limitArg.slice('--limit='.length)) : undefined,
})
if (cwdArg) snapshot.sessions = snapshot.sessions.filter((session) => session.cwd === cwdArg.slice('--cwd='.length))

if (json) {
  console.log(JSON.stringify(snapshot, null, 2))
} else {
  console.log(`Personal AI OS session index · ${snapshot.scannedAt}`)
  console.log(`只读：${snapshot.privacy.readOnly ? '是' : '否'} · 未读取凭据：${snapshot.privacy.secretsRead ? '否' : '是'}`)
  for (const source of snapshot.sources) {
    const count = snapshot.sessions.filter((session) => session.source === source.provider).length
    console.log(`- ${source.label} (${source.provider}) · ${source.detected ? '已发现' : '未发现'} · ${count} 个可索引会话`)
    if (source.limitations.length) console.log(`  限制：${source.limitations.join('；')}`)
  }
  for (const session of snapshot.sessions.slice(0, 20)) {
    console.log(`  ${session.source} · ${session.nativeSessionId} · ${session.title} · ${session.cwd}`)
  }
}


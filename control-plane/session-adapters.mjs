import { indexLocalSessions } from './session-index.mjs'
import { StoreError } from './store.mjs'

const RESUME_HINTS = Object.freeze({
  codex: 'codex app-server / native thread resume',
  opencode: 'opencode native session resume',
  kimi: 'kimi --session <id>',
  workbuddy: 'codebuddy --resume / codebuddy --acp',
  devin: 'devin --resume / devin acp',
  claude: 'Claude Code 原生 session 机制',
  antigravity: 'GUI-only / proxy provider',
})

export async function getSessionMetadata({ source, nativeSessionId, home, limit = 500 } = {}) {
  if (!source || !nativeSessionId) throw new StoreError('SESSION_REFERENCE_REQUIRED', 'source and nativeSessionId are required', 400)
  const snapshot = await indexLocalSessions({ home, providers: [source], limit })
  const session = snapshot.sessions.find((candidate) => candidate.source === source && candidate.nativeSessionId === nativeSessionId)
  if (!session) {
    const sourceInfo = snapshot.sources.find((candidate) => candidate.provider === source)
    if (sourceInfo?.detected && !sourceInfo.metadata) {
      throw new StoreError('SESSION_METADATA_UNAVAILABLE', `${source} has no verified read-only session metadata adapter`, 501, { source, limitations: sourceInfo.limitations })
    }
    throw new StoreError('SESSION_NOT_FOUND', `session ${source}/${nativeSessionId} was not found in the read-only index`, 404)
  }
  return {
    session,
    retrieval: { level: 'metadata', messageBodiesRead: false, credentialsRead: false },
    resume: resumePlan(session),
  }
}

export function resumePlan(session) {
  const hint = RESUME_HINTS[session.source] ?? 'native session mechanism'
  return {
    supported: session.capabilities.resume === 'available',
    verified: false,
    requiresApproval: true,
    nativeHint: session.resumeHint || hint,
    reason: 'resume is a write-capable external-agent action and has not been invoked by the read-only adapter',
  }
}


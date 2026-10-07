import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
export async function goalRequest(endpoint, body) {
  const token = (await fs.readFile(path.join(os.homedir(), '.local/state/personal-ai-os/goals/api-token'), 'utf8')).trim()
  const response = await fetch(`http://127.0.0.1:4326${endpoint}`, { signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.message ?? `Goal HTTP ${response.status}`)
  return result
}

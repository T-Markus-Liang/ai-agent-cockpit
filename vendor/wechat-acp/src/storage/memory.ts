import fs from "node:fs/promises";
import path from "node:path";

export type MemoryRole = "user" | "assistant";

export interface MemoryTurn {
  role: MemoryRole;
  text: string;
  at: string;
}

interface UserMemory {
  summary: string;
  turns: MemoryTurn[];
  updatedAt: string;
}

interface MemoryState {
  version: 1;
  users: Record<string, UserMemory>;
}

export interface ConversationMemoryOptions {
  file: string;
  enabled: boolean;
  maxTurns?: number;
  maxChars?: number;
  summaryChars?: number;
}

const DEFAULT_MAX_TURNS = 16;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_SUMMARY_CHARS = 6_000;

function emptyState(): MemoryState {
  return { version: 1, users: {} };
}

function clean(text: string): string {
  return text.replace(/\u0000/g, "").trim();
}

async function load(file: string): Promise<MemoryState> {
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8")) as MemoryState;
    return state?.version === 1 && state.users ? state : emptyState();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw error;
  }
}

async function save(file: string, state: MemoryState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700).catch(() => {});
  const tmp = path.join(path.dirname(file), `.memory-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, file);
}

/** Local, permission-restricted conversation memory shared across ACP providers. */
export class ConversationMemoryStore {
  private readonly maxTurns: number;
  private readonly maxChars: number;
  private readonly summaryChars: number;
  private pending = Promise.resolve();

  constructor(private readonly options: ConversationMemoryOptions) {
    this.maxTurns = Math.max(2, options.maxTurns ?? DEFAULT_MAX_TURNS);
    this.maxChars = Math.max(1_000, options.maxChars ?? DEFAULT_MAX_CHARS);
    this.summaryChars = Math.max(500, options.summaryChars ?? DEFAULT_SUMMARY_CHARS);
  }

  async context(userId: string): Promise<string> {
    if (!this.options.enabled) return "";
    const state = await load(this.options.file);
    const memory = state.users[userId];
    if (!memory || (memory.summary === "" && memory.turns.length === 0)) return "";
    const lines = [
      "[Personal AI OS conversation memory]",
      "This is local memory. It may contain a compacted summary; treat current user messages as authoritative.",
    ];
    if (memory.summary) lines.push("Summary:\n" + memory.summary);
    if (memory.turns.length) {
      lines.push("Recent turns:");
      for (const turn of memory.turns) lines.push(`${turn.role}: ${turn.text}`);
    }
    lines.push("[/Personal AI OS conversation memory]");
    return lines.join("\n");
  }

  async append(userId: string, role: MemoryRole, text: string): Promise<void> {
    if (!this.options.enabled) return;
    const normalized = clean(text);
    if (!normalized) return;
    const operation = this.pending.catch(() => {}).then(async () => {
      const state = await load(this.options.file);
      const memory = state.users[userId] ?? { summary: "", turns: [], updatedAt: new Date().toISOString() };
      memory.turns.push({ role, text: normalized, at: new Date().toISOString() });
      this.compact(memory);
      memory.updatedAt = new Date().toISOString();
      state.users[userId] = memory;
      await save(this.options.file, state);
    });
    this.pending = operation;
    await operation;
  }

  private compact(memory: UserMemory): void {
    const recent: MemoryTurn[] = [];
    let chars = memory.summary.length;
    for (let index = memory.turns.length - 1; index >= 0 && recent.length < this.maxTurns; index -= 1) {
      const turn = memory.turns[index]!;
      const nextChars = chars + turn.text.length;
      if (recent.length > 0 && nextChars > this.maxChars) break;
      recent.unshift(turn);
      chars = nextChars;
    }
    const retainedAt = recent[0]?.at;
    const archived = memory.turns.filter((turn) => !retainedAt || turn.at < retainedAt);
    if (archived.length > 0) {
      const additions = archived.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
      memory.summary = `${memory.summary}${memory.summary ? "\n" : ""}${additions}`.slice(-this.summaryChars);
    }
    memory.turns = recent;
  }
}


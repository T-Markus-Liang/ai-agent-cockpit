/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, uploadImageMedia, sendImageItem, uploadFileMedia, sendFileItem, splitText, TEXT_CHUNK_LIMIT } from "./weixin/send.js";
import type { UploadedImageMedia, UploadedFileMedia } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import {
  SessionManager,
  type ResetSessionResult,
  type RuntimeBridgeSetting,
  type PendingMessage,
  type ReplyMetadata,
  QueuedMessageDeferredError,
  SessionResetError,
} from "./acp/session.js";
import { AUDIO_MIME_EXTENSIONS } from "./acp/client.js";
import type { AgentImage, AgentAudio, AgentFile } from "./acp/client.js";
import {
  startArtifactMcpServer,
  type ArtifactMcpServer,
} from "./artifacts/server.js";
import { sanitizeFileName } from "./artifacts/store.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import type { WeChatAcpConfig } from "./config.js";
import {
  BRIDGE_COMMANDS,
  buildAgentSessionScope,
  matchBridgeCommand,
  resolveCommandAliases,
} from "./config.js";
import { drainPendingText, PendingTextRegistry } from "./pending-text.js";
import { InjectionMonitor } from "./inject/monitor.js";
import type { InjectedMessage } from "./inject/types.js";
import {
  getPersistedSessionId,
  removePersistedSession,
  resolveUserTarget,
  updateLastActiveUser,
  updatePersistedSession,
} from "./storage/state.js";
import { ConversationMemoryStore } from "./storage/memory.js";
import { MessageInbox, type MessageInboxStatus, type MessageInboxRecord } from './storage/message-inbox.js';
import { ReplyOutbox } from './storage/reply-outbox.js';
import { RecoveryLease } from './storage/recovery-lease.js';
import { SubmissionRegistry, computePayloadDigest } from './storage/submission-registry.js';
import { WeChatGoalClient } from "./goals.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const ACP_NEW_COMMAND = BRIDGE_COMMANDS.acpNew;
const ACP_MORE_COMMAND = BRIDGE_COMMANDS.acpMore;
const APPROVAL_APPROVE_COMMAND = BRIDGE_COMMANDS.approvalApprove;
const APPROVAL_REJECT_COMMAND = BRIDGE_COMMANDS.approvalReject;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;
const BUFFER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_BLOCKS = 50;
const PENDING_TEXT_TTL_MS = 10 * 60 * 1000;
const PENDING_TEXT_MAX_SEGMENTS = 50;
const SEGMENT_SEND_MAX_ATTEMPTS = 3;
const SEGMENT_SEND_RETRY_BASE_MS = 300;
const RUNTIME_BRIDGE_CONFIG_OPTIONS: ReadonlyArray<{
  id: string;
  setting: RuntimeBridgeSetting;
  name: string;
}> = [
  { id: "bridge.thoughts", setting: "thoughts", name: "Thoughts" },
  { id: "bridge.diffs", setting: "diffs", name: "Diffs" },
  { id: "bridge.images", setting: "images", name: "Tool Images" },
  { id: "bridge.audio", setting: "audio", name: "Audio" },
  { id: "bridge.resources", setting: "resources", name: "Tool Resources" },
];

interface MessageBuffer {
  receiptIds?: string[];
  blocks: acp.ContentBlock[];
  contextToken: string;
  pending: Promise<void>;
  lastUpdatedAt: number;
  generation: number;
}

/**
 * Minimum spacing between two consecutive outbound text messages to the
 * same user. Each reply segment is an independent iLink API call with no
 * ordering hint, and WeChat appears to order back-to-back bot messages by
 * server-receive time. Without spacing, near-simultaneous sends can race
 * and be delivered to the user out of order (see issue #38). A short delay
 * separates their server-side timestamps and preserves order.
 */
const REPLY_SEND_SPACING_MS = 150;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private artifactMcpServer: ArtifactMcpServer | null = null;
  private injectionMonitor: InjectionMonitor | null = null;
  private tokenData: TokenData | null = null;
  private stateUpdate = Promise.resolve();
  // Per-user typing ticket cache
  private typingTickets = new Map<string, { ticket: string; expiresAt: number }>();
  private typingChains = new Map<string, Promise<void>>();
  // Timestamp (ms) at which the last text message was issued to each user,
  // used to pace consecutive sends so they don't race and arrive reordered.
  private lastSendAt = new Map<string, number>();
  // Per-user promise chain serializing replies so concurrent sendReply calls
  // (e.g. a command reply racing an active session flush) cannot interleave
  // their segments and arrive out of order (issue #38).
  private sendChains = new Map<string, Promise<void>>();
  private messageHandlingChains = new Map<string, Promise<void>>();
  private resetEpoch = 0;
  private userResetEpochs = new Map<string, number>();
  private pendingText: PendingTextRegistry;
  // Per-user message buffer for /acp-prompt-start.../acp-prompt-done multi-part compose
  private messageBuffers = new Map<string, MessageBuffer>();
  // Per-user expiry timers for buffer cleanup
  private bufferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Users currently flushing their buffer (between /done and enqueue).
  // Maps userId to a promise that resolves when the flush completes, so
  // messages arriving during the flush wait for the buffered prompt to
  // enqueue first, preserving turn order.
  private bufferFlushing = new Map<string, Promise<void>>();
  private log: (msg: string) => void;
  private readonly conversationMemory: ConversationMemoryStore;
  private readonly messageInbox?: MessageInbox;
  private readonly replyOutbox?: ReplyOutbox;
  private readonly recoveryLease?: RecoveryLease;
  private readonly submissionRegistry?: SubmissionRegistry;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recoverySweep?: Promise<void>;
  private readonly incomingInFlight = new Set<string>();
  private readonly receiptTasks = new Set<Promise<void>>();
  private readonly outboxDrains = new Map<string, Promise<void>>();
  private readonly commandReplyIds = new Map<string, string[]>();
  private readonly acknowledgedReceipts = new Set<string>();
  private readonly latestContexts = new Map<string, string>();
  private readonly receiptIds = new WeakMap<WeixinMessage, string>();
  private readonly incomingGenerations = new WeakMap<WeixinMessage, number>();

  constructor(config: WeChatAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-acp] ${msg}`));
    if (config.inbound?.enabled || config.recovery?.enabled) {
      this.messageInbox = new MessageInbox({ dir: config.inbound?.dir ?? path.join(config.storage.dir, 'incoming-receipts') });
      this.submissionRegistry = new SubmissionRegistry({ dir: path.join(config.storage.dir, 'submission-registry') });
    }
    if (config.recovery?.enabled) {
      this.replyOutbox = new ReplyOutbox({ dir: path.join(config.storage.dir, 'reply-outbox'), maxAttempts: config.recovery.replyMaxAttempts, maxDelayMs: config.recovery.replyMaxDelayMs });
      this.recoveryLease = new RecoveryLease(config.storage.dir);
    }
    this.pendingText = new PendingTextRegistry({
      ttlMs: PENDING_TEXT_TTL_MS,
      maxUsers: Math.max(1, config.session.maxConcurrentUsers),
      maxSegmentsPerUser: PENDING_TEXT_MAX_SEGMENTS,
    });
    this.conversationMemory = new ConversationMemoryStore({
      file: config.storage.memoryFile ?? path.join(config.storage.dir, "conversation-memory.json"),
      enabled: config.memory?.enabled ?? false,
      maxTurns: config.memory?.maxTurns,
      maxChars: config.memory?.maxChars,
      summaryChars: config.memory?.summaryChars,
      mem0: config.memory?.mem0,
      onWarning: (message) => this.log(message),
    });
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    await this.recoveryLease?.acquire();
    try { await this.startOwned(opts); }
    finally { await this.recoveryLease?.close(); }
  }

  private async startOwned(opts?: { forceLogin?: boolean; renderQrUrl?: (url: string) => void }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    // 1. Login or load token
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
      if (this.tokenData) {
        trackEvent("token.reused");
      }
    }

    if (!this.tokenData) {
      const loginStart = Date.now();
      try {
        this.tokenData = await login({
          baseUrl: this.config.wechat.baseUrl,
          botType: this.config.wechat.botType,
          storageDir: this.config.storage.dir,
          log: this.log,
          renderQrUrl,
        });
        trackEvent("login.success", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
        });
      } catch (err) {
        trackException(err, "auth");
        trackEvent("login.failure", {
          forced: !!forceLogin,
          durationMs: Date.now() - loginStart,
          errorType: err instanceof Error ? err.name : "Unknown",
        });
        throw err;
      }
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log(`Use --login to force re-login`);
    }

    try {
      // 2. Start the local artifact MCP server and create SessionManager
      try {
        this.artifactMcpServer = await startArtifactMcpServer({
          rootDir: this.config.agent.cwd,
          log: this.log,
        });
      } catch (err) {
        this.log(`Artifact MCP unavailable; agent file attachments disabled: ${String(err)}`);
        trackException(err, "artifact_mcp");
      }
      const resumePolicy = this.config.session.resume ?? "off";
      if (resumePolicy !== "off" && !this.config.storage.stateFile) {
        throw new Error("Session resume requires storage.stateFile");
      }
      const sessionScope = buildAgentSessionScope(this.config.agent);
      const stateFile = this.config.storage.stateFile;
      this.sessionManager = new SessionManager({
        agentCommand: this.config.agent.command,
        agentArgs: this.config.agent.args,
        agentCwd: this.config.agent.cwd,
        agentEnv: this.config.agent.env,
        agentPreset: this.config.agent.preset ?? "raw",
        fallbackAgents: this.config.fallbackAgents,
        mcpServers: this.config.agent.mcpServers,
        idleTimeoutMs: this.config.session.idleTimeoutMs,
        maxConcurrentUsers: this.config.session.maxConcurrentUsers,
        foregroundWaitMs: this.config.session.foregroundWaitMs,
        grantDeadlineMs: this.config.session.grantDeadlineMs,
        startupTimeoutMs: this.config.session.startupTimeoutMs,
        progressNoticeMs: 10000,
        preparePrompt: async (userId, prompt, pending) => {
          await this.setReceiptStatus(pending?.receiptIds ?? [], 'running');
          const enriched = await this.enrichPromptWithMemory(userId, prompt);
          return this.config.recovery?.enabled && pending?.receiptIds?.[0] ? [...enriched, { type: 'text', text: `[可靠请求关联]\n本请求 sourceRequestId=${pending.receiptIds[0]}。如需创建控制面 Task，请在 create_task 中填写此 sourceRequestId，并以本标识作为幂等键的一部分。先查询已有关联任务，不重复派单；该标识不是执行授权，审批与任务验收门槛仍须满足。` } as const] : enriched;
        },
        onNotice: (userId, token, text, generation, current, metadata) => this.sendAgentReply(userId, token, text, this.requireReplyGeneration(generation), current, metadata),
        onTurnEvent: this.config.recovery?.enabled ? async (userId, pending, event) => {
          if (event.phase === 'background') {
            await this.handleTurnBackground(userId, pending);
            return;
          }
          for (const id of pending.receiptIds ?? []) await this.messageInbox!.checkpoint(id, { ...event, phase: event.phase as 'preparing' | 'sent-unconfirmed' | 'dispatched' | 'tool_activity' | 'result_ready', groupIds: pending.receiptIds, ...(event.phase === 'tool_activity' ? { usedTools: true } : {}) }, event.phase === 'preparing');
        } : undefined,
        resumePolicy,
        getPersistedSessionId:
          resumePolicy !== "off" && stateFile
            ? async (userId) => {
                await this.stateUpdate.catch(() => {});
                return getPersistedSessionId(stateFile, userId, sessionScope);
              }
            : undefined,
        persistSessionId:
          resumePolicy !== "off" && stateFile
            ? (userId, sessionId) =>
                this.enqueueStateUpdate(() =>
                  updatePersistedSession(stateFile, userId, sessionScope, sessionId),
                )
            : undefined,
        removePersistedSessionId:
          stateFile
            ? (userId) =>
                this.enqueueStateUpdate(() =>
                  removePersistedSession(stateFile, userId, sessionScope),
                )
            : undefined,
        turnEndMessage: this.config.session.turnEndMessage,
        showThoughts: this.config.agent.showThoughts,
        showDiffs: this.config.agent.showDiffs ?? false,
        showImages: this.config.agent.showImages ?? true,
        showAudio: this.config.agent.showAudio ?? true,
        showResources: this.config.agent.showResources ?? true,
        resourceInlineLimit: this.config.agent.resourceInlineLimit,
        createMcpLease: this.artifactMcpServer
          ? () => this.artifactMcpServer!.createLease()
          : undefined,
        log: this.log,
        onReply: (
          userId,
          contextToken,
          text,
          replyGeneration,
          isSessionCurrent,
          metadata,
        ) =>
          this.sendAgentReply(
            userId,
            contextToken,
            text,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
            metadata,
          ),
        onReplyImage: (
          userId,
          contextToken,
          image,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendImageReply(
            userId,
            contextToken,
            image,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        onReplyAudio: (
          userId,
          contextToken,
          audio,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendAudioReply(
            userId,
            contextToken,
            audio,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        onReplyFile: (
          userId,
          contextToken,
          file,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendFileReply(
            userId,
            contextToken,
            file,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
        resolveResourceLink: this.artifactMcpServer
          ? (link) => this.artifactMcpServer!.resolveResourceLink(link)
          : undefined,
        sendTyping: (
          userId,
          contextToken,
          replyGeneration,
          isSessionCurrent,
        ) =>
          this.sendTypingIndicator(
            userId,
            contextToken,
            this.requireReplyGeneration(replyGeneration),
            isSessionCurrent,
          ),
      });
      this.sessionManager.start();
      await this.replyOutbox?.recover();
      await this.recoverIncoming();
      // Backfill a runtime Submission for every inbox receipt admitted before
      // this registry existed (idempotent; never drops a receipt).
      await this.reconcileSubmissions();
      if (this.replyOutbox) {
        const sweepMs = Math.max(1000, this.config.recovery?.sweepMs ?? 5000);
        this.recoveryTimer = setInterval(() => { void this.runRecoverySweep().catch(() => this.log('Recovery sweep deferred; private state retained')); }, sweepMs);
        this.recoveryTimer.unref();
        await this.runRecoverySweep();
      }

      if (this.config.storage.injectDir && this.config.storage.stateFile) {
        this.injectionMonitor = new InjectionMonitor({
          injectDir: this.config.storage.injectDir,
          log: this.log,
          onMessage: (job) => this.enqueueInjectedMessage(job),
        });
        await this.injectionMonitor.start();
        this.log(`Injection queue: ${this.config.storage.injectDir}`);
      }

      // 3. Start monitor loop
      this.log("Starting message polling...");
      await startMonitor({
        baseUrl: this.tokenData.baseUrl,
        token: this.tokenData.token,
        storageDir: this.config.storage.dir,
        abortSignal: this.abortController.signal,
        log: this.log,
        onMessage: async (msg) => {
          if (!this.validIncoming(msg) || !await this.admitIncoming(msg)) return;
          void this.handleMessage(msg).catch((err) => {
            this.log(`Failed to handle message: ${String(err)}`);
            trackException(err, "message");
          });
        },
      });
    } catch (err) {
      try {
        await this.stop();
      } catch (cleanupErr) {
        throw new AggregateError(
          [err, cleanupErr],
          "Bridge startup failed and cleanup also failed",
        );
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    const cleanupErrors: unknown[] = [];
    try {
      await this.injectionMonitor?.stop();
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await this.sessionManager?.stop();
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      await this.artifactMcpServer?.close();
    } catch (err) {
      cleanupErrors.push(err);
    } finally {
      this.artifactMcpServer = null;
    }
    await this.stateUpdate.catch((err) => {
      this.log(`Failed to flush state before stop: ${String(err)}`);
      trackException(sanitizeStateError(err), "state");
    });
    this.log("Bridge stopped");
    await Promise.allSettled([...this.messageHandlingChains.values()]);
    while (this.receiptTasks.size) await Promise.allSettled([...this.receiptTasks]);
    await Promise.allSettled([...this.sendChains.values()]);
    await this.messageInbox?.close();
    await this.submissionRegistry?.close();
    await this.replyOutbox?.close();
    await this.recoveryLease?.close();
    await this.conversationMemory.close();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Bridge cleanup failed");
    }
  }

  async handleMessage(msg: WeixinMessage): Promise<void> {
    if (!this.validIncoming(msg) || !await this.admitIncoming(msg)) return;
    const ids = this.receiptIds.get(msg) ? [this.receiptIds.get(msg)!] : [];
    const command = this.isNativeCommand(msg);
    const commandKey = JSON.stringify([msg.from_user_id, msg.context_token]);
    if (command) this.commandReplyIds.set(commandKey, ids);
    const generation = this.incomingGenerations.get(msg);
    for (const id of ids) this.incomingInFlight.add(id);
    try {
      await this.setReceiptStatus(ids, command ? 'running' : 'queued');
      await this.handleAdmittedMessage(msg);
      if (command && this.replyOutbox) {
        for (const id of ids) await this.messageInbox!.checkpoint(id, { phase: 'result_ready', stopReason: 'control_command' });
        await this.reconcileResults(ids);
      } else if (command) await this.setReceiptStatus(ids, 'done');
      else if (generation !== undefined && !this.isMessageGenerationCurrent(msg.from_user_id!, generation)) await this.setReceiptStatus(ids, 'cancelled');
    } catch (error) {
      const errorKind = error instanceof Error ? error.name : 'Error';
      if (this.config.recovery?.enabled && !command && !(error instanceof SessionResetError)) {
        await this.retainFailedRequest(ids, errorKind);
      } else await this.setReceiptStatus(ids, error instanceof SessionResetError ? 'cancelled' : command ? 'uncertain' : 'failed', errorKind);
      throw error;
    } finally {
      if (this.commandReplyIds.get(commandKey) === ids) this.commandReplyIds.delete(commandKey);
      for (const id of ids) this.incomingInFlight.delete(id);
    }
  }

  private async handleAdmittedMessage(msg: WeixinMessage): Promise<void> {
    // Only process user messages (not bot's own messages)
    if (msg.message_type !== MessageType.USER) return;

    // Skip group messages (v1: direct only)
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    const acpNewCommand = this.extractAcpNewCommand(msg);
    if (acpNewCommand === ACP_NEW_COMMAND) {
      const generation = ++this.resetEpoch;
      this.userResetEpochs.set(userId, generation);
      return this.trackMessageHandling(
        userId,
        this.handleUserMessage(msg, userId, contextToken, generation),
      );
    }

    const generation = this.incomingGenerations.get(msg) ?? this.messageGenerationForUser(userId);
    const previous = this.messageHandlingChains.get(userId) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        return this.handleUserMessage(msg, userId, contextToken, generation);
      });
    return this.trackMessageHandling(userId, current);
  }

  private async trackMessageHandling(
    userId: string,
    current: Promise<void>,
  ): Promise<void> {
    this.messageHandlingChains.set(userId, current);
    try {
      await current;
    } finally {
      if (this.messageHandlingChains.get(userId) === current) {
        this.messageHandlingChains.delete(userId);
      }
    }
  }

  private async handleUserMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);
    this.rememberActiveUser(userId, contextToken);

    trackEvent(
      "message.received",
      {
        userIdHash: hashUserId(userId),
        kind: this.messageKind(msg),
      },
      hashUserId(userId),
    );
    void this.recordControlPlaneEvent("wechat.message_received", userId, {
      kind: this.messageKind(msg),
    });

    const textItem = msg.item_list?.length === 1 ? (msg.item_list[0]?.text_item?.text ?? msg.item_list[0]?.voice_item?.text)?.trim() : undefined;
    if (textItem && /^\/消息(?:\s|$)/.test(textItem)) {
      const records = (await this.messageInbox?.list() ?? []).filter(record => record.message.from_user_id === userId);
      const labels: Record<string, string> = { received: '已保存', queued: '排队', retry_wait: '等待自动重试', running: '处理中', background: '后台执行中', uncertain: '中断/待核对', done: '对话已结束', reply_pending: '对话已结束/回复待补发', buffered: '缓冲', cancelled: '已取消', failed: '未能处理/待核对' };
      const displayed = records.slice(-5);
      const reviewing = await this.resolveReviewingReceiptIds(displayed);
      const latest = displayed.map(record => `${new Date(record.receivedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}：${labels[record.status] ?? record.status}${reviewing.has(record.id) ? '，任务验收中' : ''}`);
      const outgoing = await this.replyOutbox?.list({ userId, statuses: ['pending', 'sending', 'blocked'] }) ?? [];
      const blocked = outgoing.filter(row => row.status === 'blocked').length;
      await this.sendReply(userId, contextToken, (latest.length ? latest.join('\n') : '暂时还没有新的可靠收件记录。') + (outgoing.length ? `\n待补发文本 ${outgoing.length} 段${blocked ? `，其中 ${blocked} 段已到重试上限；发 /acp-more 可重试补发` : '，会自动补发'}` : ''));
      return;
    }
    if (textItem && /^\/目标(?:\s|$)/.test(textItem)) {
      await this.conversationMemory.append(userId, "user", textItem);
      let reply: string;
      try { reply = this.config.goals ? await new WeChatGoalClient(this.config.goals).command(userId, textItem) : '持续目标服务还未配置，请从本机仪表盘查看。'; }
      catch { reply = '这次没能连接或执行目标操作。可能是目标服务未就绪、权限不匹配或预算已到上限；请在仪表盘查看具体状态。'; }
      if (this.isMessageGenerationCurrent(userId, generation)) {
        await this.conversationMemory.append(userId, "assistant", reply);
        if (this.isMessageGenerationCurrent(userId, generation)) await this.sendReply(userId, contextToken, reply);
      }
      return;
    }
    const approvalApproveCommand = this.extractBridgeCommand(msg, APPROVAL_APPROVE_COMMAND);
    const approvalRejectCommand = this.extractBridgeCommand(msg, APPROVAL_REJECT_COMMAND);
    if (approvalApproveCommand || approvalRejectCommand) {
      await this.handleApprovalCommand(
        approvalApproveCommand ?? approvalRejectCommand!,
        approvalApproveCommand ? "approved" : "rejected",
        userId,
        contextToken,
        generation,
      );
      return;
    }

    const acpNewCommand = this.extractAcpNewCommand(msg);
    if (acpNewCommand) {
      if (acpNewCommand.trim().split(/\s+/).length === 1 && this.replyOutbox) {
        await this.replyOutbox.cancelForUser(userId);
        await this.messageInbox!.cancelForUser(userId, this.receiptIds.get(msg));
      }
      await this.handleAcpNewCommand(
        acpNewCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    const acpConfigCommand = this.extractAcpConfigCommand(msg);
    if (acpConfigCommand) {
      await this.handleAcpConfigCommand(
        acpConfigCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    const acpCancelCommand = this.extractAcpCancelCommand(msg);
    if (acpCancelCommand) {
      await this.handleAcpCancelCommand(
        acpCancelCommand,
        userId,
        contextToken,
        generation,
      );
      return;
    }

    if (this.extractBridgeCommand(msg, ACP_MORE_COMMAND)) {
      await this.handleAcpMoreCommand(userId, contextToken, generation);
      return;
    }

    // /acp-prompt-start — enter buffering mode
    if (this.isBufferStartCommand(msg)) {
      this.handleBufferStart(userId, contextToken, generation);
      return;
    }

    // /acp-prompt-done — flush buffer and send to agent
    if (this.isBufferDoneCommand(msg)) {
      await this.handleBufferDone(userId, contextToken, generation);
      return;
    }

    // If user is in buffering mode, append to buffer instead of enqueuing
    if (this.messageBuffers.has(userId)) {
      this.appendToBuffer(msg, userId, contextToken);
      return;
    }

    this.beginAgentPrompt(userId, contextToken);
    const waitForFlush = this.bufferFlushing.get(userId);
    await (waitForFlush
      ? waitForFlush.then(() =>
          this.enqueueMessage(
            msg,
            userId,
            contextToken,
            () => this.isMessageGenerationCurrent(userId, generation),
            generation,
          ),
        )
      : this.enqueueMessage(
          msg,
          userId,
          contextToken,
          () => this.isMessageGenerationCurrent(userId, generation),
          generation,
        ));
  }

  protected async enqueueMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
    isCurrent: () => boolean = () => true,
    replyGeneration?: number,
  ): Promise<void> {
    const ids = this.receiptIds.get(msg) ? [this.receiptIds.get(msg)!] : [];
    const voice = msg.item_list?.find(item => item.type === 3);
    if (!isCurrent()) { await this.setReceiptStatus(ids, 'cancelled'); return; }
    if (voice && !voice.voice_item?.text?.trim() && !msg.item_list?.some(item => item.text_item?.text?.trim())) {
      await this.sendAgentReply(userId, contextToken, '收到语音了，但这次没有转写文字，我还不能执行内容。请重发或发文字；消息记录已保留。', replyGeneration ?? this.messageGenerationForUser(userId), isCurrent);
      await this.setReceiptStatus(ids, 'failed', 'MissingVoiceTranscription');
      return;
    }
    const capacityBusy = this.config.recovery?.enabled && this.sessionManager?.canEnqueue?.(userId) === false;
    const busy = capacityBusy || this.sessionManager?.getSession(userId)?.processing === true;
    if (ids.length && !ids.every(id => this.acknowledgedReceipts.has(id)) && (busy || (voice && this.config.inbound?.acknowledgeVoice))) {
      for (const id of ids) this.acknowledgedReceipts.add(id);
      await this.sendAgentReply(userId, contextToken, busy ? '这条消息已保存。上一条还在处理，我会按顺序继续，不会把后发的消息丢掉。' : '语音已转成文字并保存，我来处理。', replyGeneration ?? this.messageGenerationForUser(userId), isCurrent, { kind: 'progress' });
    }
    if (capacityBusy || await this.hasUnconfirmedOldProcess(userId)) return;
    const prompt = await weixinMessageToPrompt(
      msg,
      this.config.wechat.cdnBaseUrl,
      this.log,
      this.config.storage.inboxDir,
    );

    if (!isCurrent()) return;
    await this.sessionManager!.enqueue(userId, {
      receiptIds: ids,
      completion: this.receiptCompletion(ids),
      prompt,
      contextToken,
      replyGeneration,
    });
  }

  private validIncoming(msg: WeixinMessage): boolean {
    return msg.message_type === MessageType.USER && !msg.group_id && Boolean(msg.from_user_id && msg.context_token);
  }

  private async admitIncoming(msg: WeixinMessage): Promise<boolean> {
    if (!this.incomingGenerations.has(msg)) this.incomingGenerations.set(msg, this.messageGenerationForUser(msg.from_user_id!));
    if (!this.messageInbox) return true;
    // Already admitted in this process, or seeded by the recovery sweep (which
    // sets receiptIds before re-admitting): the receipt is already durable, so
    // re-register idempotently instead of returning early — a retry after a
    // failed registration re-runs the registration, never silently skips it.
    if (this.receiptIds.has(msg)) {
      await this.registerSubmission(this.receiptIds.get(msg)!, msg);
      return true;
    }
    const result = await this.messageInbox.put(msg);
    this.latestContexts.set(msg.from_user_id!, msg.context_token!);
    await this.replyOutbox?.refreshContext(msg.from_user_id!, msg.context_token!);
    if (!result.isNew) return false;
    this.receiptIds.set(msg, result.record.id);
    // Register the durable runtime Submission before the receipt is handled. A
    // failure (including a poisoned registry) throws so the message stays in the
    // inbox for the existing monitor/ recovery-sweep admission retry — it is
    // never reported as already handled.
    await this.registerSubmission(result.record.id, result.record.message);
    return true;
  }

  /** Idempotently record the runtime Submission for a durable receipt. */
  private async registerSubmission(receiptId: string, message: WeixinMessage): Promise<void> {
    if (!this.submissionRegistry) return;
    await this.submissionRegistry.register({
      receiptId,
      userId: message.from_user_id!,
      payloadDigest: computePayloadDigest(message),
    });
  }

  /**
   * Backfill submissions for inbox receipts with no registration yet (startup
   * reconciliation). Idempotent; a registration failure surfaces fail-closed
   * instead of being silently swallowed.
   */
  private async reconcileSubmissions(): Promise<void> {
    if (!this.messageInbox || !this.submissionRegistry) return;
    for (const record of await this.messageInbox.list()) {
      if (await this.submissionRegistry.has(record.id)) continue;
      await this.registerSubmission(record.id, record.message);
    }
  }

  private isNativeCommand(msg: WeixinMessage): boolean {
    if (Object.values(BRIDGE_COMMANDS).some(command => this.extractBridgeCommand(msg, command) !== null)) return true;
    const item = msg.item_list?.length === 1 ? msg.item_list[0] : undefined;
    const text = (item?.text_item?.text ?? item?.voice_item?.text ?? '').trim();
    return /^\/(目标|消息)(?:\s|$)/.test(text);
  }

  private async setReceiptStatus(ids: string[], status: MessageInboxStatus, errorKind?: string): Promise<void> {
    if (!this.messageInbox) return;
    for (const id of ids) await this.messageInbox.setStatus(id, status, errorKind ? { errorKind } : undefined);
  }

  /**
   * A foreground wait elapsed while the turn is still running: record the turn
   * as background work on its receipts and tell the user once (per turn) that
   * the result will arrive later. This never dispatches, cancels, or replays
   * work — the turn keeps running on its original ACP prompt, and its eventual
   * result is delivered through the existing result_ready → outbox path.
   */
  private async handleTurnBackground(userId: string, pending: PendingMessage): Promise<void> {
    const receiptIds = pending.receiptIds ?? [];
    try {
      await this.setReceiptStatus(receiptIds, 'background');
    } catch (err) {
      this.log(`Background receipt status update failed: ${String(err)}`);
    }
    const notice = '这条任务已转入后台执行，完成后的结果会照常发给你。后台期间你可以继续发新消息，也可以发 /acp-cancel 取消。';
    if (this.replyOutbox) {
      // A durable dedupeKey makes the notice idempotent: a repeated background
      // event for the same turn can never deliver it twice.
      await this.replyOutbox.put({ userId, contextToken: pending.contextToken, text: notice, receiptIds, kind: 'notice', dedupeKey: `${receiptIds[0] ?? userId}:turn-background` });
      void this.flushReplyOutbox(userId).catch(() => this.log('Background notice queued for durable retry'));
      return;
    }
    await this.sendReply(userId, pending.contextToken, notice);
  }

  private receiptCompletion(ids: string[]): PendingMessage['completion'] {
    if (!this.messageInbox || !ids.length) return undefined;
    const update = (status: MessageInboxStatus, errorKind?: string) => {
      void this.setReceiptStatus(ids, status, errorKind).catch(() => this.log('Receipt final status not confirmed; original retained, never assumed complete'));
    };
    if (this.config.recovery?.enabled) return {
      resolve: () => this.trackReceiptTask(this.reconcileResults(ids, true)),
      reject: error => this.trackReceiptTask(error instanceof QueuedMessageDeferredError
        ? this.setReceiptStatus(ids, 'queued')
        : error instanceof SessionResetError || /Cancelled before queued/.test(String(error))
          ? this.setReceiptStatus(ids, 'cancelled') : this.retainFailedRequest(ids, error instanceof Error ? error.name : 'Error')),
    };
    return { resolve: () => update('done'), reject: error => update(error instanceof QueuedMessageDeferredError ? 'queued' : error instanceof SessionResetError || /Cancelled before queued/.test(String(error)) ? 'cancelled' : 'uncertain', error instanceof Error ? error.name : 'Error') };
  }

  private trackReceiptTask(task: Promise<void>): void {
    this.receiptTasks.add(task);
    void task.catch(() => this.log('Recovery journal update deferred; request is never assumed completed')).finally(() => this.receiptTasks.delete(task));
  }

  private async retainFailedRequest(ids: string[], errorKind: string): Promise<void> {
    if (!this.messageInbox) return;
    for (const id of ids) {
      const record = (await this.messageInbox.list()).find(row => row.id === id);
      if (!record || ['done', 'cancelled', 'failed', 'uncertain'].includes(record.status)) continue;
      if (record.execution?.phase === 'result_ready') { await this.reconcileResults([id]); continue; }
      const retryCount = record.execution?.retryCount ?? 0;
      const retry = await this.messageInbox.scheduleRetry(id, { maxAttempts: this.config.recovery?.maxAttempts ?? 3,
        delayMs: Math.min(120000, (this.config.recovery?.baseDelayMs ?? 15000) * 2 ** retryCount), errorKind });
      if (!retry && record.execution && record.execution.phase !== 'preparing') await this.setReceiptStatus([id], 'uncertain', errorKind);
    }
  }

  /** A recorded ACP result proves the turn ended: recover output, never rerun tools. */
  private async reconcileResults(ids: string[], requireResult = false): Promise<void> {
    if (!this.messageInbox || !this.replyOutbox) return;
    for (const id of ids) {
      let record = (await this.messageInbox.list()).find(row => row.id === id);
      if (!record || ['done', 'cancelled', 'failed', 'uncertain'].includes(record.status)) continue;
      if (this.sessionManager?.getSession(record.message.from_user_id!)?.activeMessage?.receiptIds?.includes(id)) continue;
      if (record.execution?.phase !== 'result_ready') { if (requireResult) await this.setReceiptStatus([id], 'uncertain', 'MissingResultCheckpoint'); continue; }
      if (record.execution.stopReason === 'cancelled') { await this.setReceiptStatus([id], 'cancelled'); continue; }
      let replies = (await this.replyOutbox.list()).filter(row => row.kind === 'reply' && row.receiptIds.includes(id));
      const group = record.execution.groupIds?.length ? record.execution.groupIds : [id], primary = group[0]!;
      const full = record.execution.resultText?.trim() ?? '';
      const saved = replies.map(row => row.text).join('');
      const normal = (value: string) => value.replace(/\s+/gu, '');
      const recoveredId = crypto.createHash('sha256').update(JSON.stringify([record.message.from_user_id, `${primary}:recovered-result:0`])).digest('hex');
      if (full && normal(full) !== normal(saved) && !replies.some(row => row.id === recoveredId)) {
        let missing = full;
        if (normal(full).startsWith(normal(saved))) {
          let consumed = 0, cut = 0; const length = normal(saved).length;
          while (cut < full.length && consumed < length) { if (!/\s/u.test(full[cut]!)) consumed++; cut++; }
          missing = full.slice(cut).trim();
        } else missing = `补发已结束对话的留存回答（可能包含先前已发部分）：\n${full}`;
        for (const [index, text] of splitText(missing, TEXT_CHUNK_LIMIT).entries()) if (text.trim()) await this.replyOutbox.put({ userId: record.message.from_user_id!, contextToken: record.message.context_token!, text,
          receiptIds: group, kind: 'reply', dedupeKey: `${primary}:recovered-result:${index}` });
        replies = (await this.replyOutbox.list()).filter(row => row.kind === 'reply' && row.receiptIds.includes(id));
      }
      if (!replies.length) await this.replyOutbox.put({ userId: record.message.from_user_id!, contextToken: record.message.context_token!, text: '这轮对话已经结束，但没有可确认的文字结果。我保留了请求，暂不重跑已可能执行的操作。', receiptIds: group, kind: 'reply', dedupeKey: `${primary}:empty-result` });
      replies = (await this.replyOutbox.list()).filter(row => row.kind === 'reply' && row.receiptIds.includes(id));
      if (full && replies.some(row => row.id === recoveredId) && !record.execution.resultArchived) {
        await this.conversationMemory.append(record.message.from_user_id!, 'assistant', full);
        for (const groupId of group) await this.messageInbox.checkpoint(groupId, { resultArchived: true });
      }
      record = (await this.messageInbox.list()).find(row => row.id === id);
      if (!record || ['done', 'cancelled', 'failed', 'uncertain'].includes(record.status)) continue;
      await this.setReceiptStatus([id], replies.every(row => row.status === 'sent') ? 'done' : 'reply_pending');
    }
  }

  private runRecoverySweep(): Promise<void> {
    if (this.recoverySweep) return this.recoverySweep;
    const task = this.sweepRecovery(); this.recoverySweep = task;
    void task.finally(() => { if (this.recoverySweep === task) this.recoverySweep = undefined; }).catch(() => {});
    return task;
  }

  private async sweepRecovery(): Promise<void> {
    if (!this.messageInbox || !this.replyOutbox || this.abortController.signal.aborted) return;
    const records = await this.messageInbox.list();
    for (const record of records) {
      const user = record.message.from_user_id!;
      const session = this.sessionManager?.getSession(user);
      const liveIds = [session?.activeMessage, ...(session?.queue ?? [])].flatMap(message => message?.receiptIds ?? []);
      if (this.incomingInFlight.has(record.id) || liveIds.includes(record.id)) continue;
      if (record.status === 'reply_pending' || (record.status === 'running' && record.execution?.phase === 'result_ready')) { await this.reconcileResults([record.id]); continue; }
      if (['received', 'queued', 'retry_wait'].includes(record.status) && (record.execution?.retryAt ?? 0) <= Date.now()) {
        if (await this.hasUnconfirmedOldProcess(user)) {
          if (!record.execution?.noticeQueued) {
            await this.replyOutbox.put({ userId: user, contextToken: record.message.context_token!, text: '这条请求已保存，正在等待旧 Agent 的进程退出，暂不启动重复执行；确认清理后会自动接续。', kind: 'notice', receiptIds: [record.id], dedupeKey: `${record.id}:waiting-old-process` });
            await this.messageInbox.checkpoint(record.id, { noticeQueued: true });
          }
          continue;
        }
        if (!this.validIncoming(record.message) || this.isNativeCommand(record.message)) continue;
        this.receiptIds.set(record.message, record.id); this.incomingGenerations.set(record.message, this.messageGenerationForUser(user));
        await this.handleMessage(record.message).catch(() => this.log('Admission retry deferred; checkpoint retained'));
      } else if (['uncertain', 'failed'].includes(record.status)) {
        if (await this.reconcileLinkedTask(record.id)) { await this.reconcileResults([record.id]); continue; }
        if (record.execution?.noticeQueued) continue;
        await this.replyOutbox.put({ userId: user, contextToken: record.message.context_token!, text: '有一条请求中断或未能完成，原文已保留。无法确认已执行到哪一步，我不会整条重跑；已列入待核对，请发 /消息 查看。', receiptIds: [record.id], kind: 'notice', dedupeKey: `${record.id}:needs-review` });
        await this.messageInbox.checkpoint(record.id, { noticeQueued: true });
      }
    }
    const users = new Set((await this.replyOutbox.list({ statuses: ['pending'] })).map(row => row.userId));
    // Sending occurs on its own per-user chain; network loss cannot block task admission.
    for (const user of users) void this.flushReplyOutbox(user).catch(() => this.log('Reply delivery deferred; original text retained'));
  }

  private async reconcileLinkedTask(receiptId: string): Promise<boolean> {
    if (!this.config.controlPlaneUrl || !this.messageInbox) return false;
    try {
      const record = (await this.messageInbox.list()).find(row => row.id === receiptId);
      if (!record || ['done', 'cancelled'].includes(record.status)) return false;
      const sourceRequestId = record?.execution?.groupIds?.[0] ?? receiptId;
      const base = new URL(this.config.controlPlaneUrl); if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return false;
      const query = new URL('/api/control-plane/tasks', base); query.searchParams.set('sourceRequestId', sourceRequestId); query.searchParams.set('limit', '500');
      const response = await fetch(query, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return false;
      const body = await response.json() as { tasks?: Array<{ id: string; sourceRequestId?: string; status: string; goal: string }> };
      const matching = body.tasks?.filter(task => task.sourceRequestId === sourceRequestId) ?? [];
      if (!matching.length || matching.length >= 500 || matching.some(task => task.status !== 'completed')) return false;
      for (const task of matching) {
        const detailResponse = await fetch(new URL(`/api/control-plane/tasks/${encodeURIComponent(task.id)}`, base), { signal: AbortSignal.timeout(3000) });
        if (!detailResponse.ok) return false;
        const detail = await detailResponse.json() as { task?: typeof task & { completionProof?: { parametersDigest: string; at: string } }; evidence?: Array<{ kind: string; exitCode?: number; verdict?: string }> };
        if (detail.task?.id !== task.id || detail.task.status !== 'completed' || detail.task.sourceRequestId !== sourceRequestId || !/^sha256:[a-f0-9]{64}$/.test(detail.task.completionProof?.parametersDigest ?? '') || !Number.isFinite(Date.parse(detail.task.completionProof?.at ?? '')) || !detail.evidence?.some(row => row.kind === 'test' && row.exitCode === 0) || !detail.evidence.some(row => row.kind === 'review' && row.verdict === 'passed')) return false;
      }
      await this.messageInbox.acceptTaskResult(receiptId, { sourceRequestId, taskId: matching[0]!.id, completed: true,
        text: `中断后的关联任务已有完成、测试和复核记录，我不再重复执行，现补发结果：\n${matching.map(task => task.goal.slice(0, 600)).join('\n')}` });
      return true;
    } catch { return false; }
  }

  /**
   * Display-layer derivation for /消息: which of the shown receipts have a linked
   * control-plane task currently in 验收 (verifying/reviewing). Purely derived —
   * no receipt schema or status is persisted, and a query failure/timeout or a
   * non-loopback control plane silently yields no extra label (never fabricated).
   * Mirrors reconcileLinkedTask's loopback-only + bounded-timeout + fail-closed
   * query pattern. At most 5 deduplicated sourceRequestId queries per render.
   */
  private async resolveReviewingReceiptIds(records: MessageInboxRecord[]): Promise<Set<string>> {
    const reviewing = new Set<string>();
    if (!this.config.controlPlaneUrl || !records.length) return reviewing;
    let base: URL;
    try { base = new URL(this.config.controlPlaneUrl); } catch { return reviewing; }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return reviewing;
    const bySource = new Map<string, string[]>();
    for (const record of records) {
      const sourceRequestId = record.execution?.groupIds?.[0] ?? record.id;
      const ids = bySource.get(sourceRequestId) ?? []; ids.push(record.id); bySource.set(sourceRequestId, ids);
    }
    await Promise.all([...bySource.entries()].slice(0, 5).map(async ([sourceRequestId, receiptIds]) => {
      try {
        const query = new URL('/api/control-plane/tasks', base); query.searchParams.set('sourceRequestId', sourceRequestId); query.searchParams.set('limit', '50');
        const response = await fetch(query, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return;
        const body = await response.json() as { tasks?: Array<{ sourceRequestId?: string; status: string }> };
        const matching = body.tasks?.filter(task => task.sourceRequestId === sourceRequestId) ?? [];
        if (matching.some(task => task.status === 'verifying' || task.status === 'reviewing')) for (const id of receiptIds) reviewing.add(id);
      } catch { /* Unreachable/slow/malformed control plane: keep original labels. */ }
    }));
    return reviewing;
  }

  private flushReplyOutbox(userId: string, force = false): Promise<void> {
    const existing = this.outboxDrains.get(userId); if (existing) return existing;
    const task = this.queueSendTask(userId, async () => {
      if (!this.replyOutbox || this.abortController.signal.aborted) return;
      for (let count = 0; count < 50; count++) {
        const [record] = await this.replyOutbox.claimDue({ userId, limit: 1, force }); if (!record) break;
        const receipts = await this.messageInbox?.list() ?? [];
        if (record.receiptIds.some(id => receipts.some(row => row.id === id && row.status === 'cancelled'))) {
          await this.replyOutbox.cancelForReceipts(record.receiptIds); continue;
        }
        let sent = false;
        try { sent = await this.sendTextSegment(userId, record.contextToken, record.text, () => !this.abortController.signal.aborted, record.clientId); }
        catch { /* Only a sanitized kind is recorded, never a credential-bearing body. */ }
        await this.replyOutbox.settle(record.id, { sent, errorKind: sent ? undefined : 'WeChatDeliveryFailed' });
        await this.reconcileResults(record.receiptIds);
        if (!sent) break;
      }
    });
    this.outboxDrains.set(userId, task);
    void task.finally(() => { if (this.outboxDrains.get(userId) === task) this.outboxDrains.delete(userId); }).catch(() => {});
    return task;
  }

  private async hasUnconfirmedOldProcess(userId: string): Promise<boolean> {
    if (!this.replyOutbox || !this.messageInbox) return false;
    const owned = this.sessionManager?.getSession(userId)?.agentInfo?.process.pid;
    for (const record of await this.messageInbox.list()) {
      const pid = record.execution?.processId;
      if (record.message.from_user_id !== userId || !['received', 'queued', 'retry_wait', 'running'].includes(record.status) || record.execution?.phase !== 'preparing' || !pid || pid === owned) continue;
      try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true; }
    }
    return false;
  }

  private async recoverIncoming(): Promise<void> {
    if (!this.messageInbox) return;
    const result = await this.messageInbox.recover();
    this.log(`Durable inbox recovery: pending=${result.pending.length}, uncertain=${result.uncertainCount}`);
    for (const record of result.pending) {
      if (!this.validIncoming(record.message)) continue;
      if (await this.hasUnconfirmedOldProcess(record.message.from_user_id!)) continue;
      this.receiptIds.set(record.message, record.id);
      this.incomingGenerations.set(record.message, this.messageGenerationForUser(record.message.from_user_id!));
      await this.handleMessage(record.message);
    }
  }

  private async enrichPromptWithMemory(
    userId: string,
    prompt: acp.ContentBlock[],
  ): Promise<acp.ContentBlock[]> {
    const userText = prompt
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: string; text?: string }).text ?? "")
      .join("\n")
      .trim();
    const memoryContext = await this.conversationMemory.context(userId, userText);
    await this.conversationMemory.append(userId, "user", userText);
    const personaFile = this.config.memory?.personaFile;
    const persona = personaFile ? await fs.readFile(personaFile, "utf8").catch(() => "") : "";
    const context = [persona ? `[Trusted assistant persona and operating rules]\n${persona.slice(0, 12000)}\n[/Trusted assistant persona and operating rules]` : "", memoryContext].filter(Boolean).join("\n\n");
    return context ? [{ type: "text", text: context }, ...prompt] : prompt;
  }

  private async handleApprovalCommand(
    command: string,
    decision: "approved" | "rejected",
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    const approvalId = args[1];
    if (args.length !== 2 || !approvalId || approvalId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(approvalId)) {
      await this.sendReply(
        userId,
        contextToken,
        decision === "approved"
          ? "用法：/approve <approval_id>（也支持 /批准 <approval_id>）"
          : "用法：/reject <approval_id>（也支持 /拒绝 <approval_id>）",
      );
      return;
    }
    const baseUrl = (this.config.controlPlaneUrl ?? "http://127.0.0.1:4324").replace(/\/$/, "");
    try {
      const response = await fetch(`${baseUrl}/api/control-plane/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `wechat-${userId}-${approvalId}-${decision}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ decision, approvedBy: `wechat:${userId}` }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      await this.sendReply(
        userId,
        contextToken,
        decision === "approved" ? `✅ 已批准：${approvalId}` : `⛔ 已拒绝：${approvalId}`,
      );
    } catch (error) {
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      await this.sendReply(userId, contextToken, `⚠️ 审批处理失败：${describeError(error)}`);
    }
  }

  private async recordControlPlaneEvent(
    type: string,
    userId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.controlPlaneAudit) return;
    const baseUrl = (this.config.controlPlaneUrl ?? "http://127.0.0.1:4324").replace(/\/$/, "");
    try {
      await fetch(`${baseUrl}/api/control-plane/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `wechat-audit-${type}-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          type,
          entityType: "WeChatUser",
          entityId: `wechat:${hashUserId(userId)}`,
          details,
        }),
      });
    } catch (error) {
      this.log(`Control-plane audit unavailable: ${String(error)}`);
    }
  }

  protected async resetUserSession(
    userId: string,
  ): Promise<ResetSessionResult> {
    if (!this.sessionManager) {
      throw new Error("Bridge is not ready yet.");
    }
    return this.sessionManager.resetSession(userId);
  }

  private async handleAcpNewCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length > 1) {
      await this.sendReply(
        userId,
        contextToken,
        this.formatAcpNewUsage(`Unknown argument: ${args.slice(1).join(" ")}`),
      );
      return;
    }

    const buffer = this.messageBuffers.get(userId);
    const droppedBufferedBlockCount = buffer?.blocks.length ?? 0;
    this.messageBuffers.delete(userId);
    this.bufferFlushing.delete(userId);
    this.clearBufferTimer(userId);
    this.pendingText.clearExisting(userId);
    const typingCancellation = this.cancelTypingIndicator(
      userId,
      contextToken,
    ).catch((err) => {
      this.log(`Failed to cancel typing for ${userId}: ${String(err)}`);
    });

    try {
      const result = await this.resetUserSession(userId);
      await typingCancellation;
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      trackEvent(
        "command.acp_new",
        {
          userIdHash: hashUserId(userId),
          hadActiveSession: result.hadActiveSession,
          cancelledTurn: result.cancelledTurn,
          cancelledPendingCreation: result.cancelledPendingCreation,
          droppedQueueCount: result.droppedQueueCount,
          droppedBufferedBlockCount,
        },
        hashUserId(userId),
      );
      await this.sendReply(
        userId,
        contextToken,
        this.formatAcpNewResult(result, droppedBufferedBlockCount),
      );
    } catch (err) {
      await typingCancellation;
      this.log(`Failed to reset ACP session for ${userId}: ${String(err)}`);
      trackException(err, "session.reset", hashUserId(userId));
      if (!this.isMessageGenerationCurrent(userId, generation)) return;
      await this.sendReply(
        userId,
        contextToken,
        `⚠️ Could not fully clear the ACP session: ${describeError(err)}. Restarting now may restore the previous context.`,
      );
    }
  }

  private formatAcpNewResult(
    result: ResetSessionResult,
    droppedBufferedBlockCount: number,
  ): string {
    const lines = [
      "✅ ACP session cleared. Your next message will start a fresh session.",
    ];
    if (result.droppedQueueCount > 0) {
      lines.push(`Dropped ${result.droppedQueueCount} queued message(s).`);
    }
    if (droppedBufferedBlockCount > 0) {
      lines.push(
        `Dropped ${droppedBufferedBlockCount} buffered content block(s).`,
      );
    }
    return lines.join("\n");
  }

  private formatAcpNewUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`, "");
    }
    lines.push(
      "💡 **Usage**",
      `   • Start a fresh session:  ${ACP_NEW_COMMAND}${this.aliasHint(ACP_NEW_COMMAND)}`,
    );
    return lines.join("\n");
  }

  private async enqueueInjectedMessage(job: InjectedMessage): Promise<void> {
    if (!this.sessionManager || !this.config.storage.stateFile) {
      throw new Error("Bridge is not ready to process injected messages");
    }

    const admittedResetEpoch = this.resetEpoch;
    const target = await this.resolveInjectedTarget(job);
    const generation = this.messageGenerationForUser(target.userId);
    if (generation > admittedResetEpoch) {
      throw new Error(
        `Injected message ${job.id} was discarded because the target ACP session was reset`,
      );
    }
    this.beginAgentPrompt(target.userId, target.contextToken);
    const prompt: acp.ContentBlock[] = [{ type: "text", text: job.text }];
    this.log(`[inject] enqueue ${job.id} for ${target.userId}`);
    trackEvent(
      "message.injected",
      {
        userIdHash: hashUserId(target.userId),
        targetKind: job.target === "last-active-user" ? "last-active-user" : "explicit",
      },
      hashUserId(target.userId),
    );
    await this.sessionManager.enqueueAndWait(target.userId, {
      prompt,
      contextToken: target.contextToken,
      replyGeneration: generation,
    });
  }

  protected resolveInjectedTarget(job: InjectedMessage): Promise<{
    userId: string;
    contextToken: string;
  }> {
    return resolveUserTarget(
      this.config.storage.stateFile!,
      job.target,
      job.contextToken,
    );
  }

  private async handleAcpConfigCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    if (args.length === 1) {
      const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
      const runtimeSettings = this.sessionManager?.getRuntimeBridgeSettings(userId);
      trackEvent(
        "command.acp_config.view",
        {
          userIdHash: hashUserId(userId),
          hasSession: !!runtimeSettings,
          optionCount: runtimeSettings
            ? RUNTIME_BRIDGE_CONFIG_OPTIONS.length + (configOptions?.length ?? 0)
            : 0,
        },
        hashUserId(userId),
      );
      await this.sendReply(userId, contextToken, this.formatAcpConfigList(userId));
      return;
    }

    if (args[1] === "set") {
      if (args.length < 4) {
        await this.sendReply(userId, contextToken, this.formatAcpConfigUsage("Missing configId or value."));
        return;
      }

      const configId = args[2]!;
      const rawValue = args.slice(3).join(" ");
      try {
        const runtimeOption = RUNTIME_BRIDGE_CONFIG_OPTIONS.find(
          (option) => option.id === configId,
        );
        let displayValue: string;
        let optionType: string;
        if (runtimeOption) {
          if (!this.sessionManager?.getRuntimeBridgeSettings(userId)) {
            throw new Error(
              "No active ACP session for this chat yet. Send a normal message first.",
            );
          }
          const value = this.resolveBooleanConfigValue(configId, rawValue);
          this.sessionManager.setRuntimeBridgeSetting(
            userId,
            runtimeOption.setting,
            value,
          );
          displayValue = value ? "on" : "off";
          optionType = "boolean";
        } else {
          const resolved = this.resolveAcpConfigValue(userId, configId, rawValue);
          await this.sessionManager!.setSessionConfigOption(
            userId,
            configId,
            resolved.rawValue,
          );
          displayValue = resolved.displayValue;
          optionType = this.sessionManager!
            .getSessionConfigOptions(userId)
            ?.find((option) => option.id === configId)?.type ?? "unknown";
        }
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        trackEvent(
          "command.acp_config.set",
          {
            userIdHash: hashUserId(userId),
            configId,
            optionType,
            optionValue: displayValue,
          },
          hashUserId(userId),
        );
        await this.sendReply(
          userId,
          contextToken,
          `✅ Updated ACP config: ${configId} = ${displayValue}\n\n${this.formatAcpConfigList(userId)}`,
        );
      } catch (err) {
        if (!this.isMessageGenerationCurrent(userId, generation)) return;
        await this.sendReply(
          userId,
          contextToken,
          this.formatAcpConfigUsage(err instanceof Error ? err.message : String(err)),
        );
      }
      return;
    }

    await this.sendReply(
      userId,
      contextToken,
      this.formatAcpConfigUsage(`Unknown subcommand: ${args[1]}`),
    );
  }

  private async handleAcpCancelCommand(
    command: string,
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const args = command.trim().split(/\s+/);
    const sub = args[1]?.toLowerCase();

    if (sub && sub !== "all") {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage(`Unknown subcommand: ${args[1]}`));
      return;
    }

    if (!this.sessionManager) {
      await this.sendReply(userId, contextToken, this.formatAcpCancelUsage("Bridge is not ready yet."));
      return;
    }

    const drainQueue = sub === "all";
    const result = await this.sessionManager.cancelCurrent(userId, { drainQueue });
    if (!this.isMessageGenerationCurrent(userId, generation)) return;

    trackEvent(
      "command.acp_cancel",
      {
        userIdHash: hashUserId(userId),
        drainQueue,
        cancelledTurn: result.cancelledTurn,
        droppedQueueCount: result.droppedQueueCount,
      },
      hashUserId(userId),
    );

    await this.sendReply(userId, contextToken, this.formatAcpCancelResult(result, drainQueue));
  }

  protected async handleAcpMoreCommand(
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const isCurrent = () =>
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, async () => {
      if (!isCurrent()) return;
      // Renew durable blocked outbox segments for this user: /acp-more only
      // re-queues delivery attempts (status -> pending, attempts reset to 0,
      // nextAttemptAt = now). The existing outbox drain performs the actual
      // send, so no ACP task is ever re-executed here. In-memory pending text
      // is drained separately below; both paths are reported to the user.
      const renewedBlockedCount = this.replyOutbox
        ? await this.replyOutbox.retryBlockedForUser(userId)
        : 0;
      if (!isCurrent()) return;
      const result = await drainPendingText(
        this.pendingText,
        userId,
        (segment) =>
          isCurrent()
            ? this.sendTextSegment(userId, contextToken, segment, isCurrent)
            : Promise.resolve(false),
      );
      if (!isCurrent()) return;
      trackEvent(
        "command.acp_more",
        {
          userIdHash: hashUserId(userId),
          renewedBlockedCount,
          pendingCount: result.pendingCount,
          sentCount: result.sentCount,
          remainingCount: result.remainingCount,
        },
        hashUserId(userId),
      );
      // Report both renewal paths faithfully: the durable blocked segments that
      // were just re-queued for delivery and the in-memory pending text drained
      // above. Only when neither path had anything do we say there is nothing.
      const renewedParts: string[] = [];
      if (renewedBlockedCount > 0) renewedParts.push(`已恢复 ${renewedBlockedCount} 段到重试上限的待补发文本，稍后会自动重试补发。`);
      if (result.pendingCount > 0) renewedParts.push(`待补发文本共 ${result.pendingCount} 段，本次已发出 ${result.sentCount} 段${result.remainingCount > 0 ? `，仍有 ${result.remainingCount} 段未发出` : ''}。`);
      if (renewedParts.length > 0) await this.sendTextSegment(userId, contextToken, renewedParts.join('\n'), isCurrent);
      if (result.pendingCount === 0 && renewedBlockedCount === 0) {
        await this.sendTextSegment(
          userId,
          contextToken,
          "目前没有待补发的消息。",
          isCurrent,
        );
      }
      if (!isCurrent()) return;
      this.cancelTypingIndicator(userId, contextToken).catch(() => {});
    });
  }

  private formatAcpCancelResult(
    result: { cancelledTurn: boolean; droppedQueueCount: number },
    drainQueue: boolean,
  ): string {
    const lines: string[] = [];
    if (result.cancelledTurn) {
      lines.push("🛑 Cancel signal sent. The current ACP turn will stop shortly.");
    } else {
      lines.push("ℹ️ No active ACP turn to cancel.");
    }
    if (drainQueue && result.droppedQueueCount > 0) {
      lines.push(`Dropped ${result.droppedQueueCount} queued message(s).`);
    }
    lines.push("");
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private formatAcpCancelUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`);
      lines.push("");
    }
    lines.push("💡 **Usage**");
    lines.push(`   • Cancel current turn:        ${ACP_CANCEL_COMMAND}${this.aliasHint(ACP_CANCEL_COMMAND)}`);
    lines.push(`   • Cancel + drop queued msgs:  ${ACP_CANCEL_COMMAND} all`);
    return lines.join("\n");
  }

  private isBufferStartCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_START_COMMAND) !== null;
  }

  private isBufferDoneCommand(msg: WeixinMessage): boolean {
    return this.extractBridgeCommand(msg, BUFFER_DONE_COMMAND) !== null;
  }

  private handleBufferStart(
    userId: string,
    contextToken: string,
    generation: number,
  ): void {
    const existing = this.messageBuffers.get(userId);
    if (existing?.generation === generation) {
      const buffer = existing;
      this.sendReply(userId, contextToken, `📝 Already in buffering mode (${buffer.blocks.length} block(s) collected). Keep sending, then ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit.`).catch((err) => {
        this.log(`Failed to send buffer active notice to ${userId}: ${String(err)}`);
      });
      return;
    }
    if (existing) {
      this.messageBuffers.delete(userId);
      this.clearBufferTimer(userId);
    }

    const buffer: MessageBuffer = {
      blocks: [],
      contextToken,
      pending: Promise.resolve(),
      lastUpdatedAt: Date.now(),
      generation,
    };
    this.messageBuffers.set(userId, buffer);
    this.resetBufferTimer(userId, buffer);
    this.log(`Buffer started for ${userId}`);
    trackEvent(
      "command.buffer_start",
      { userIdHash: hashUserId(userId) },
      hashUserId(userId),
    );
    this.sendReply(userId, contextToken, `📝 Buffering mode started. Send your messages (text, images, files), then send ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit them all at once.`).catch((err) => {
      this.log(`Failed to send buffer start confirmation to ${userId}: ${String(err)}`);
    });
  }

  private handleBufferDone(
    userId: string,
    contextToken: string,
    generation: number,
  ): Promise<void> {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer || buffer.generation !== generation) {
      return this.sendReply(userId, contextToken, `⚠️ Nothing buffered. Send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} first, then send messages before ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}.`);
    }

    this.beginAgentPrompt(userId, contextToken);

    // Remove from map immediately so new messages during the await
    // are not appended to a stale buffer.
    const pending = buffer.pending;
    this.messageBuffers.delete(userId);
    this.clearBufferTimer(userId);

    // Register a flushing promise so messages arriving during the await
    // queue behind the buffered prompt, preserving turn order.
    const flushPromise = this.doFlush(
      userId,
      contextToken,
      buffer,
      pending,
      () => this.isMessageGenerationCurrent(userId, generation),
      generation,
    );
    this.bufferFlushing.set(userId, flushPromise);
    void flushPromise.finally(() => {
      // Only clear if this is still our flush (not a newer one)
      if (this.bufferFlushing.get(userId) === flushPromise) {
        this.bufferFlushing.delete(userId);
      }
    }).catch(() => {});
    return flushPromise;
  }

  private async doFlush(
    userId: string,
    contextToken: string,
    buffer: MessageBuffer,
    pending: Promise<void>,
    isCurrent: () => boolean,
    replyGeneration: number,
  ): Promise<void> {
    // Wait for any in-flight appends to finish before reading
    try {
      await pending;
    } catch {
      if (!isCurrent()) return;
      // A prior append failed (e.g. image download error). The chain
      // already logged/tracked the error. Clear the buffer so the user
      // can start fresh.
      await this.sendReply(userId, contextToken, `⚠️ A buffered message failed to process. Buffer cleared. Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} to try again.`);
      return;
    }

    if (!isCurrent()) return;

    // Check expiry
    if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
      await this.sendReply(userId, contextToken, `⚠️ Buffer expired (10 min without activity). Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} to start over.`);
      return;
    }

    if (buffer.blocks.length === 0) {
      await this.sendReply(userId, contextToken, `⚠️ Buffer is empty. Send some messages before ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)}.`);
      return;
    }

    this.log(`Buffer flushed for ${userId}: ${buffer.blocks.length} block(s)`);
    trackEvent(
      "command.buffer_done",
      {
        userIdHash: hashUserId(userId),
        blockCount: buffer.blocks.length,
      },
      hashUserId(userId),
    );

    if (!isCurrent()) return;
    await this.enqueueBufferedPrompt(
      userId,
      contextToken,
      buffer.blocks,
      replyGeneration,
      buffer.receiptIds,
    );
  }

  protected async enqueueBufferedPrompt(
    userId: string,
    contextToken: string,
    prompt: acp.ContentBlock[],
    replyGeneration?: number,
    ids: string[] = [],
  ): Promise<void> {
    if (this.replyOutbox) {
      await this.replyOutbox.retryBlockedForUser(userId);
      await this.replyOutbox.refreshContext(userId, contextToken);
      await this.flushReplyOutbox(userId, true);
      return;
    }
    await this.sessionManager!.enqueue(userId, {
      receiptIds: ids,
      completion: this.receiptCompletion(ids),
      prompt,
      contextToken,
      replyGeneration,
    });
  }

  private appendToBuffer(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): void {
    const buffer = this.messageBuffers.get(userId);
    if (!buffer) return;
    const id = this.receiptIds.get(msg);
    if (id) { (buffer.receiptIds ??= []).push(id); void this.setReceiptStatus([id], 'buffered').catch(() => this.log('Buffered receipt update failed; original remains on disk')); }
    const isCurrentBuffer = () =>
      this.messageBuffers.get(userId) === buffer &&
      this.isMessageGenerationCurrent(userId, buffer.generation);

    // Chain the async conversion so /acp-prompt-done waits for all in-flight appends
    buffer.pending = buffer.pending
      .then(async () => {
        // Re-check buffer still exists (could have been flushed or expired)
        if (!isCurrentBuffer()) return;

        // Check TTL
        if (Date.now() - buffer.lastUpdatedAt > BUFFER_TTL_MS) {
          this.messageBuffers.delete(userId);
          this.log(`Buffer expired for ${userId}`);
          await this.sendReply(userId, contextToken, `⚠️ Buffering timed out (10 min without activity). Please send ${BUFFER_START_COMMAND}${this.aliasHint(BUFFER_START_COMMAND)} again.`);
          return;
        }

        // Check block limit
        if (buffer.blocks.length >= BUFFER_MAX_BLOCKS) {
          await this.sendReply(userId, contextToken, `⚠️ Buffer is full (${BUFFER_MAX_BLOCKS} blocks max). Send ${BUFFER_DONE_COMMAND}${this.aliasHint(BUFFER_DONE_COMMAND)} to submit what you have.`);
          return;
        }

        const prompt = await weixinMessageToPrompt(
          msg,
          this.config.wechat.cdnBaseUrl,
          this.log,
          this.config.storage.inboxDir,
        );
        if (!isCurrentBuffer()) return;
        buffer.blocks.push(...prompt);
        buffer.contextToken = contextToken;
        buffer.lastUpdatedAt = Date.now();
        this.resetBufferTimer(userId, buffer);

        this.log(`Buffered message from ${userId}, now ${buffer.blocks.length} block(s)`);
      });

    buffer.pending.catch((err) => {
      this.log(`Failed to buffer message from ${userId}: ${String(err)}`);
      trackException(err, "buffer", hashUserId(userId));
    });
  }

  private resetBufferTimer(userId: string, expectedBuffer: MessageBuffer): void {
    this.clearBufferTimer(userId);
    this.bufferTimers.set(userId, setTimeout(() => {
      const buffer = this.messageBuffers.get(userId);
      if (buffer !== expectedBuffer) return;
      this.messageBuffers.delete(userId);
      this.bufferTimers.delete(userId);
      this.log(`Buffer expired (timer) for ${userId}`);
    }, BUFFER_TTL_MS));
  }

  private clearBufferTimer(userId: string): void {
    const timer = this.bufferTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.bufferTimers.delete(userId);
    }
  }

  private rememberActiveUser(userId: string, contextToken: string): void {
    if (!this.config.storage.stateFile) return;
    const update = this.enqueueStateUpdate(() =>
      updateLastActiveUser(this.config.storage.stateFile!, userId, contextToken),
    );
    update.catch((err) => {
      this.log(`Failed to persist last active user: ${String(err)}`);
      trackException(sanitizeStateError(err), "state", hashUserId(userId));
    });
  }

  private enqueueStateUpdate(update: () => Promise<void>): Promise<void> {
    const pending = this.stateUpdate.catch(() => {}).then(update);
    this.stateUpdate = pending;
    return pending;
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    const ids = this.commandReplyIds.get(JSON.stringify([userId, contextToken]));
    // Serialize all replies to the same user behind a per-user promise chain so
    // that segments from separate sendReply calls cannot interleave (issue #38).
    // The stored link swallows errors so one failed reply doesn't break the
    // chain for the next caller, while the returned promise still propagates.
    const generation = this.messageGenerationForUser(userId);
    const isCurrent = () =>
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, () => {
      if (!isCurrent()) return Promise.resolve();
      if (this.replyOutbox) return this.persistTextReply(userId, contextToken, text, { receiptIds: ids });
      return this.deliverReply(
        userId,
        contextToken,
        text,
        undefined,
        isCurrent,
      );
    });
  }

  protected beginAgentPrompt(userId: string, contextToken: string): void {
    this.pendingText.supersede(userId, contextToken);
  }

  protected async sendAgentReply(
    userId: string,
    contextToken: string,
    text: string,
    replyGeneration: number,
    isSessionCurrent: () => boolean = () => true,
    metadata?: ReplyMetadata,
  ): Promise<void> {
    const generation = this.pendingText.generationForContext(userId, contextToken);
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      async (isCurrent) => {
        if (!isCurrent()) return;
        await this.conversationMemory.append(userId, "assistant", text);
        if (!isCurrent()) return;
        if (this.replyOutbox && metadata?.kind !== 'progress') {
          return this.persistTextReply(userId, contextToken, text, metadata);
        }
        return this.deliverReply(
          userId,
          contextToken,
          text,
          generation,
          isCurrent,
        );
      },
      isSessionCurrent,
    );
  }

  private async persistTextReply(userId: string, contextToken: string, text: string, metadata?: ReplyMetadata): Promise<void> {
    contextToken = this.latestContexts.get(userId) ?? contextToken;
    for (const [index, segment] of splitText(text, TEXT_CHUNK_LIMIT).entries()) if (segment.trim()) await this.replyOutbox!.put({ userId, contextToken, text: segment,
      receiptIds: metadata?.receiptIds ?? [], kind: metadata?.kind === 'notice' ? 'notice' : 'reply', dedupeKey: metadata?.dedupeKey ? `${metadata.dedupeKey}:segment:${index}` : undefined });
    void this.flushReplyOutbox(userId).catch(() => this.log('Reply queued for durable retry'));
  }

  private queueAgentSendTask(
    userId: string,
    generation: number,
    task: (isCurrent: () => boolean) => Promise<void>,
    isSessionCurrent: () => boolean = () => true,
  ): Promise<void> {
    const isCurrent = () =>
      isSessionCurrent() &&
      this.isMessageGenerationCurrent(userId, generation);
    return this.queueSendTask(userId, () => {
      if (!isCurrent()) {
        return Promise.resolve();
      }
      return task(isCurrent);
    });
  }

  private queueSendTask(userId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sendChains.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.sendChains.set(userId, current.catch(() => {}));
    return current;
  }

  private async deliverReply(
    userId: string,
    contextToken: string,
    text: string,
    generation?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const segments = splitText(text, TEXT_CHUNK_LIMIT);
    const startedAt = Date.now();
    let segmentsSent = 0;
    const failedSegments: string[] = [];

    for (const segment of segments) {
      if (!isCurrent()) return;
      const sent = await this.sendTextSegment(
        userId,
        contextToken,
        segment,
        isCurrent,
      );
      if (!isCurrent()) return;
      if (sent) {
        segmentsSent++;
      } else {
        failedSegments.push(segment);
      }
    }

    if (generation !== undefined) {
      this.pendingText.recordFailures(userId, generation, failedSegments);
    }

    if (failedSegments.length > 0) {
      trackException(
        new Error(
          `deliverReply: ${failedSegments.length}/${segments.length} segment(s) failed to send after retries`,
        ),
        "reply",
        hashUserId(userId),
      );
    }

    trackEvent(
      "reply.sent",
      {
        userIdHash: hashUserId(userId),
        segments: segments.length,
        segmentsSent,
        chars: text.length,
        durationMs: Date.now() - startedAt,
      },
      hashUserId(userId),
    );
    void this.recordControlPlaneEvent("wechat.reply_sent", userId, {
      segments: segments.length,
      segmentsSent,
      chars: text.length,
      durationMs: Date.now() - startedAt,
    });

    // Cancel typing indicator after reply is sent
    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
  }

  protected async sendTextSegment(
    userId: string,
    contextToken: string,
    segment: string,
    isCurrent: () => boolean = () => true,
    persistentClientId?: string,
  ): Promise<boolean> {
    const segmentClientId = persistentClientId ?? `wechat-acp-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return false;
      try {
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return false;
        await sendTextMessage(
          userId,
          segment,
          {
            baseUrl: this.tokenData!.baseUrl,
            token: this.tokenData!.token,
            contextToken,
          },
          segmentClientId,
        );
        return true;
      } catch (err) {
        if (!isCurrent()) return false;
        trackException(err, "reply.segment", hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }
    return false;
  }

  private async sendImageReply(
    userId: string,
    contextToken: string,
    image: AgentImage,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    // Ride the same per-user chain as text replies so an image cannot
    // interleave with the segments of a concurrent text reply.
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      (isCurrent) =>
        this.deliverImage(userId, contextToken, image, isCurrent),
      isSessionCurrent,
    );
  }

  private async deliverImage(
    userId: string,
    contextToken: string,
    image: AgentImage,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const buffer = Buffer.from(image.data, "base64");
    const startedAt = Date.now();
    // Stable idempotency key across attempts. Together with reusing the
    // uploaded media descriptor below, every send attempt carries a
    // byte-identical payload, so the iLink gateway can de-duplicate by
    // client_id without a retry ever referencing different media.
    const clientId = `wechat-acp-${crypto.randomUUID()}`;
    const sendOpts = {
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      contextToken,
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
    };
    let media: UploadedImageMedia | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return;
      try {
        // Upload once; only re-run if a previous attempt failed before the
        // upload completed. A send-stage failure retries with the same media.
        media ??= await uploadImageMedia(userId, buffer, sendOpts);
        if (!isCurrent()) return;
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return;
        await sendImageItem(userId, media, sendOpts, clientId);
        if (!isCurrent()) return;
        trackEvent(
          "reply.image.sent",
          {
            userIdHash: hashUserId(userId),
            bytes: buffer.length,
            mimeType: image.mimeType,
            durationMs: Date.now() - startedAt,
          },
          hashUserId(userId),
        );
        this.cancelTypingIndicator(userId, contextToken).catch(() => {});
        return;
      } catch (err) {
        if (!isCurrent()) return;
        lastError = err;
        trackException(err, "reply.image", hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }

    // Propagate so the ACP client appends its delivery-failure placeholder.
    throw lastError instanceof Error
      ? lastError
      : new Error(`deliverImage: failed after ${SEGMENT_SEND_MAX_ATTEMPTS} attempts`);
  }

  private async sendAudioReply(
    userId: string,
    contextToken: string,
    audio: AgentAudio,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    const mime = audio.mimeType.trim().toLowerCase();
    const ext = Object.hasOwn(AUDIO_MIME_EXTENSIONS, mime) ? AUDIO_MIME_EXTENSIONS[mime] : "bin";
    const fileName = `audio-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
    return this.queueFileReply(
      userId,
      contextToken,
      { data: audio.data, name: fileName, mimeType: audio.mimeType },
      "audio",
      replyGeneration,
      isSessionCurrent,
    );
  }

  private async sendFileReply(
    userId: string,
    contextToken: string,
    file: AgentFile,
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    return this.queueFileReply(
      userId,
      contextToken,
      file,
      "file",
      replyGeneration,
      isSessionCurrent,
    );
  }

  private async queueFileReply(
    userId: string,
    contextToken: string,
    file: AgentFile,
    telemetryKind: "audio" | "file",
    replyGeneration: number,
    isSessionCurrent?: () => boolean,
  ): Promise<void> {
    // Ride the same per-user chain as text and image replies so a file cannot
    // interleave with the segments of a concurrent reply.
    return this.queueAgentSendTask(
      userId,
      replyGeneration,
      (isCurrent) =>
        this.deliverFile(
          userId,
          contextToken,
          file,
          telemetryKind,
          isCurrent,
        ),
      isSessionCurrent,
    );
  }

  private async deliverFile(
    userId: string,
    contextToken: string,
    file: AgentFile,
    telemetryKind: "audio" | "file",
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!isCurrent()) return;
    const buffer = Buffer.from(file.data, "base64");
    const startedAt = Date.now();
    // Stable idempotency key and name across attempts, same contract as
    // deliverImage: every send attempt carries a byte-identical payload.
    const clientId = `wechat-acp-${crypto.randomUUID()}`;
    const fileName = sanitizeFileName(file.name);
    const sendOpts = {
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      contextToken,
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
    };
    let media: UploadedFileMedia | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SEGMENT_SEND_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent()) return;
      try {
        // Upload once; only re-run if a previous attempt failed before the
        // upload completed. A send-stage failure retries with the same media.
        media ??= await uploadFileMedia(userId, buffer, sendOpts);
        if (!isCurrent()) return;
        await this.paceConsecutiveSend(userId);
        if (!isCurrent()) return;
        await sendFileItem(userId, media, fileName, sendOpts, clientId);
        if (!isCurrent()) return;
        trackEvent(
          `reply.${telemetryKind}.sent`,
          {
            userIdHash: hashUserId(userId),
            bytes: buffer.length,
            mimeType: file.mimeType,
            durationMs: Date.now() - startedAt,
          },
          hashUserId(userId),
        );
        this.cancelTypingIndicator(userId, contextToken).catch(() => {});
        return;
      } catch (err) {
        if (!isCurrent()) return;
        lastError = err;
        trackException(err, `reply.${telemetryKind}`, hashUserId(userId));
        if (attempt < SEGMENT_SEND_MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, SEGMENT_SEND_RETRY_BASE_MS * attempt));
        }
      }
    }

    // Propagate so the ACP client appends its delivery-failure placeholder.
    throw lastError instanceof Error
      ? lastError
      : new Error(`deliverFile: failed after ${SEGMENT_SEND_MAX_ATTEMPTS} attempts`);
  }

  /**
   * Wait, if necessary, so that consecutive text messages to the same user
   * are issued at least {@link REPLY_SEND_SPACING_MS} apart. This spaces
   * out their server-receive timestamps so WeChat preserves the order the
   * bridge sent them in, instead of racing and delivering them reversed
   * (issue #38). Sends to different users are tracked independently and do
   * not delay each other.
   */
  private async paceConsecutiveSend(userId: string): Promise<void> {
    const last = this.lastSendAt.get(userId);
    const now = Date.now();
    if (last !== undefined) {
      const wait = REPLY_SEND_SPACING_MS - (now - last);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    this.lastSendAt.set(userId, Date.now());
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    return this.queueTypingTask(userId, async () => {
      const ticket = await this.getTypingTicket(userId, contextToken);
      if (!ticket) return;
      await this.sendTypingStatus(userId, ticket, TypingStatus.CANCEL);
    });
  }

  protected async sendTypingIndicator(
    userId: string,
    contextToken: string,
    replyGeneration: number,
    isSessionCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.queueTypingTask(userId, async () => {
      if (
        !isSessionCurrent() ||
        !this.isMessageGenerationCurrent(userId, replyGeneration)
      ) {
        return;
      }
      try {
        const ticket = await this.getTypingTicket(userId, contextToken);
        if (
          !ticket ||
          !isSessionCurrent() ||
          !this.isMessageGenerationCurrent(userId, replyGeneration)
        ) {
          return;
        }
        await this.sendTypingStatus(
          userId,
          ticket,
          TypingStatus.TYPING,
        );
      } catch {
        // Typing is best-effort
      }
    });
  }

  protected async sendTypingStatus(
    userId: string,
    ticket: string,
    status: (typeof TypingStatus)[keyof typeof TypingStatus],
  ): Promise<void> {
    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status,
      },
    });
  }

  private queueTypingTask(
    userId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    const previous = this.typingChains.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const stored = current.catch(() => {});
    this.typingChains.set(userId, stored);
    void stored.finally(() => {
      if (this.typingChains.get(userId) === stored) {
        this.typingChains.delete(userId);
      }
    });
    return current;
  }

  private async getTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;

    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: userId,
        contextToken,
      });

      if (resp.typing_ticket) {
        this.typingTickets.set(userId, {
          ticket: resp.typing_ticket,
          expiresAt: Date.now() + 24 * 60 * 60_000, // 24h cache
        });
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }

  private messageKind(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1) return "text";
      if (item.type === 2) return "image";
      if (item.type === 3) return "voice";
      if (item.type === 4) return "file";
      if (item.type === 5) return "video";
    }
    return "empty";
  }

  private extractAcpConfigCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CONFIG_COMMAND);
  }

  private extractAcpCancelCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_CANCEL_COMMAND);
  }

  private extractAcpNewCommand(msg: WeixinMessage): string | null {
    return this.extractBridgeCommand(msg, ACP_NEW_COMMAND);
  }

  private isMessageGenerationCurrent(
    userId: string,
    generation: number,
  ): boolean {
    return this.messageGenerationForUser(userId) === generation;
  }

  protected messageGenerationForUser(userId: string): number {
    return this.userResetEpochs.get(userId) ?? 0;
  }

  private requireReplyGeneration(
    replyGeneration: number | undefined,
  ): number {
    if (replyGeneration === undefined) {
      throw new Error("Agent callback is missing its reset generation");
    }
    return replyGeneration;
  }

  private extractBridgeCommand(msg: WeixinMessage, canonical: string): string | null {
    const items = msg.item_list ?? [];
    if (items.length !== 1) return null;

    const item = items[0];
    const text = item?.type === 1 ? item.text_item?.text : item?.type === 3 ? item.voice_item?.text : undefined;
    if (!text) return null;
    return matchBridgeCommand(text, canonical, this.config.commandAliases);
  }

  /**
   * Render a usage hint suffix listing any configured aliases for a
   * canonical command, e.g. " (aliases: /cancel, /取消)". Returns an
   * empty string when no aliases are configured.
   */
  private aliasHint(canonical: string): string {
    const aliases = resolveCommandAliases(canonical, this.config.commandAliases);
    return aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
  }

  private formatAcpConfigList(userId: string): string {
    const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
    const runtimeSettings = this.sessionManager?.getRuntimeBridgeSettings(userId);
    if (!runtimeSettings) {
      return this.formatAcpConfigUsage(
        "No active ACP session for this chat yet. Send a normal message first.",
      );
    }

    const lines: string[] = [];
    lines.push("⚙️ **Runtime Bridge Config**");
    lines.push("━━━━━━━━━━━━━━━━");

    for (const option of RUNTIME_BRIDGE_CONFIG_OPTIONS) {
      lines.push("");
      lines.push(`📌 **${option.name}**  (id: \`${option.id}\`)`);
      lines.push(`   • Current: ${runtimeSettings[option.setting] ? "on" : "off"}`);
      lines.push("   • Options: on | off");
    }

    lines.push("");
    lines.push("⚙️ **ACP Session Config**");
    lines.push("━━━━━━━━━━━━━━━━");

    if (!configOptions || configOptions.length === 0) {
      lines.push("");
      lines.push("The current ACP agent does not expose any configurable session options.");
    } else {
      for (const option of configOptions) {
        lines.push("");
        lines.push(`📌 **${option.name}**  (id: \`${option.id}\`)`);
        lines.push(`   • Current: ${this.describeCurrentConfigValue(option)}`);
        if (option.type === "select") {
          lines.push(`   • Options: ${this.listConfigOptionChoices(option).join(" | ")}`);
        } else if (option.type === "boolean") {
          lines.push(`   • Options: true | false`);
        }
      }
    }

    lines.push("");
    lines.push("━━━━━━━━━━━━━━━━");
    lines.push("💡 **Usage**");
    lines.push(`   • View:   ${ACP_CONFIG_COMMAND}${this.aliasHint(ACP_CONFIG_COMMAND)}`);
    lines.push(`   • Update: ${ACP_CONFIG_COMMAND} set <configId> <value>`);
    return lines.join("\n");
  }

  private formatAcpConfigUsage(error?: string): string {
    const lines: string[] = [];
    if (error) {
      lines.push(`⚠️ ${error}`);
      lines.push("");
    }
    lines.push("💡 **Usage**");
    lines.push(`   • View:   ${ACP_CONFIG_COMMAND}${this.aliasHint(ACP_CONFIG_COMMAND)}`);
    lines.push(`   • Update: ${ACP_CONFIG_COMMAND} set <configId> <value>`);
    return lines.join("\n");
  }

  private describeCurrentConfigValue(option: acp.SessionConfigOption): string {
    if (option.type === "boolean") {
      return option.currentValue ? "true" : "false";
    }

    const current = this.findConfigOptionChoice(option, option.currentValue);
    return current ? this.describeConfigChoice(current) : option.currentValue;
  }

  private listConfigOptionChoices(option: acp.SessionConfigOption): string[] {
    if (option.type !== "select") return [];
    return this.flattenSelectOptions(option.options).map((choice) => this.describeConfigChoice(choice));
  }

  private resolveAcpConfigValue(
    userId: string,
    configId: string,
    rawValue: string,
  ): { rawValue: string | boolean; displayValue: string } {
    const configOptions = this.sessionManager?.getSessionConfigOptions(userId);
    if (!configOptions) {
      throw new Error("No active ACP session for this chat yet. Send a normal message first.");
    }

    const option = configOptions.find((candidate) => candidate.id === configId);
    if (!option) {
      throw new Error(`Unknown ACP config option: ${configId}`);
    }

    if (option.type === "boolean") {
      const value = this.resolveBooleanConfigValue(configId, rawValue);
      return { rawValue: value, displayValue: String(value) };
    }

    const candidates = this.flattenSelectOptions(option.options).filter((choice) =>
      this.configChoiceAliases(choice).has(rawValue.trim().toLowerCase())
    );
    if (candidates.length === 0) {
      throw new Error(
        `Invalid value for ${configId}: ${rawValue}. Options: ${this.listConfigOptionChoices(option).join(", ")}`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(`Ambiguous value for ${configId}: ${rawValue}`);
    }

    const match = candidates[0]!;
    return {
      rawValue: match.value,
      displayValue: this.describeConfigChoice(match),
    };
  }

  private resolveBooleanConfigValue(configId: string, rawValue: string): boolean {
    const normalized = rawValue.trim().toLowerCase();
    if (["true", "on", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "off", "0", "no"].includes(normalized)) {
      return false;
    }
    throw new Error(`Invalid boolean value for ${configId}: ${rawValue}`);
  }

  private flattenSelectOptions(
    options: acp.SessionConfigSelect["options"],
  ): acp.SessionConfigSelectOption[] {
    if (options.length === 0) return [];

    const first = options[0];
    if (first && "value" in first) {
      return options as acp.SessionConfigSelectOption[];
    }

    return (options as acp.SessionConfigSelectGroup[]).flatMap((group) => group.options);
  }

  private findConfigOptionChoice(
    option: acp.SessionConfigSelect,
    rawValue: string,
  ): acp.SessionConfigSelectOption | undefined {
    return this.flattenSelectOptions(option.options).find((choice) => choice.value === rawValue);
  }

  private configChoiceAliases(choice: acp.SessionConfigSelectOption): Set<string> {
    const aliases = new Set<string>();
    aliases.add(choice.value.toLowerCase());
    aliases.add(choice.name.toLowerCase());

    const compactName = choice.name.toLowerCase().replace(/\s+/g, "-");
    aliases.add(compactName);

    const tail = this.extractConfigValueTail(choice.value);
    if (tail) aliases.add(tail.toLowerCase());

    return aliases;
  }

  private describeConfigChoice(choice: acp.SessionConfigSelectOption): string {
    const tail = this.extractConfigValueTail(choice.value);
    if (tail && tail.toLowerCase() !== choice.name.toLowerCase()) {
      return tail;
    }
    return choice.value;
  }

  private extractConfigValueTail(value: string): string {
    const hashIndex = value.lastIndexOf("#");
    if (hashIndex >= 0 && hashIndex < value.length - 1) {
      return value.slice(hashIndex + 1);
    }

    const slashIndex = value.lastIndexOf("/");
    if (slashIndex >= 0 && slashIndex < value.length - 1) {
      return value.slice(slashIndex + 1);
    }

    return value;
  }
}

function sanitizeStateError(err: unknown): Error {
  const code = typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : "";
  const sanitized = new Error(code ? `State persistence failed (${code})` : "State persistence failed");
  sanitized.name = err instanceof Error ? err.name : "Error";
  sanitized.stack = undefined;
  return sanitized;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    return err.message;
  }
  return String(err);
}

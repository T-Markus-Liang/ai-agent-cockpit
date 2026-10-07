import fs from 'node:fs/promises';
import crypto from 'node:crypto';

type Goal = { id: string; status: string; specDigest: string; spec: { title: string; objective: string; writePaths: string[]; limits: { maxIterations: number; maxTokens: number } }; iterations: number; summary?: string; reason?: string; lastChecks?: Array<{ name: string; exitCode: number | null }> };
const labels: Record<string, string> = { draft: '等你确认范围', ready: '准备下一轮', running: '正在自主处理', paused: '已暂停', waiting: '需要你帮忙', complete: '已完成验收', cancelled: '已取消' };
export class WeChatGoalClient {
  constructor(private readonly options: { url: string; tokenFile: string }) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('goal service must be loopback HTTP');
  }
  private async request(user: string, endpoint: string, body?: unknown): Promise<{ goals?: Goal[]; goal?: Goal }> {
    const token = (await fs.readFile(this.options.tokenFile, 'utf8')).trim();
    if (!token) throw new Error('目标服务认证尚未就绪');
    const actor = `wechat-${crypto.createHash('sha256').update(user).digest('hex')}`;
    const response = await fetch(`${new URL(this.options.url).origin}${endpoint}`, { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, 'X-Goal-Actor': actor, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json() as { goals?: Goal[]; goal?: Goal; message?: string };
    if (!response.ok) throw new Error(result.message ?? `目标服务 HTTP ${response.status}`);
    return result;
  }
  async command(user: string, text: string): Promise<string> {
    const words = text.trim().split(/\s+/), action = words[1] ?? '列表', id = words[2];
    if (['暂停全部', '恢复全部'].includes(action) && words.length === 2) {
      await this.request(user, `/api/goals/${action === '暂停全部' ? 'pause-all' : 'resume-all'}`, {});
      return action === '暂停全部' ? '全部持续目标已暂停，不再启动新的修改。' : '全局调度已恢复；仍在授权和预算内的目标会继续。';
    }
    if (action === '列表' && words.length <= 2) {
      const goals = (await this.request(user, '/api/goals')).goals ?? [];
      return goals.length ? goals.slice(0, 6).map(goal => `${goal.spec.title}：${labels[goal.status] ?? goal.status}，第 ${goal.iterations} 轮。\n${goal.id}`).join('\n\n') : '现在还没有持续目标。可以先在仪表盘创建草稿，确认范围后我会自己推进。';
    }
    if (!id || !/^goal_[a-z0-9-]+$/.test(id)) return '可以这样用：/目标，或 /目标 查看、暂停、恢复、取消 <目标ID>。';
    if (action === '查看' && words.length === 3) {
      const goal = (await this.request(user, `/api/goals/${id}`)).goal!;
      const checks = goal.lastChecks?.map(check => `${check.name}：${check.exitCode === 0 ? '通过' : '未通过'}`).join('；');
      return `${goal.spec.title}，${labels[goal.status] ?? goal.status}。\n${goal.summary ?? goal.spec.objective}\n${goal.reason ?? ''}\n${checks ?? '还没有验收结果。'}\n允许修改：${goal.spec.writePaths.join(', ')}（独立副本）。\n上限 ${goal.spec.limits.maxIterations} 轮、${goal.spec.limits.maxTokens} token。${goal.status === 'draft' ? `\n确认命令：/目标 确认 ${id} ${goal.specDigest}` : ''}`.trim();
    }
    const methods: Record<string, string> = { 暂停: 'pause', 恢复: 'resume', 取消: 'cancel', 确认: 'grant' };
    const operation = methods[action];
    if (!operation || (action !== '确认' && words.length !== 3)) return '支持查看、暂停、恢复、取消。确认目标时，请复制“查看”返回的完整确认命令。';
    if (action === '确认' && (words.length !== 4 || !/^sha256:[a-f0-9]{64}$/.test(words[3]!))) return '请先查看目标范围，再复制完整确认命令；我不会替你猜要批准哪个版本。';
    const goal = (await this.request(user, `/api/goals/${id}/${operation}`, operation === 'grant' ? { digest: words[3] } : {})).goal!;
    return `${goal.spec.title}，${labels[goal.status] ?? goal.status}。${goal.reason ? ` ${goal.reason}` : ''}`;
  }
}

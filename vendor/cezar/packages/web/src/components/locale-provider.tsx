import { LanguagesIcon } from 'lucide-react'
import * as React from 'react'

export type Locale = 'en' | 'zh-CN'
const STORAGE_KEY = 'cez-locale'
const TRANSLATIONS: Record<string, string> = {
  Dashboard: '仪表盘', 'All tasks': '全部任务', Tasks: '任务', Inbox: '收件箱',
  Git: 'Git', GitHub: 'GitHub', Tracker: 'Issue 跟踪', Automations: '自动化',
  Skills: '技能', Workflows: '工作流', Settings: '设置', 'Global settings': '全局设置',
  'New task': '新建任务', 'Add project': '添加项目', 'Open local folder…': '打开本地文件夹…',
  'Clone from GitHub…': '从 GitHub 克隆…', Main: '主导航', 'Close menu': '关闭菜单',
  'Open menu': '打开菜单', Language: '语言', English: 'English', Chinese: '中文',
  Theme: '主题', light: '浅色', dark: '深色', system: '跟随系统',
  General: '常规', Appearance: '外观', Notifications: '通知', Resources: '资源', Projects: '项目',
  'Agent accounts': 'Agent 账号', 'Agent config': 'Agent 配置', Worktrees: '工作树', Bookmarklets: '书签脚本',
  'Local agents': '本机 Agent', 'Local CLI, ACP and GUI channels available on this Mac.': '本机可用的 CLI、ACP 和 GUI 通道。',
  'Prompt templates': '提示词模板', 'Issue tracker': 'Issue 跟踪',
  'Configure this project and its agents.': '配置此项目及其 Agent。',
  'Preferences for you and this machine, shared by every project.': '你和本机的偏好设置，所有项目共享。',
  'Theme, accent and density.': '主题、强调色和密度。',
  'Browser notifications when an agent needs you.': 'Agent 需要你时发送浏览器通知。',
  'Parallel tasks and per-task memory limit, across every project.': '所有项目的并行任务和单任务内存限制。',
  'Updates for skills installed on this machine.': '更新本机已安装的技能。',
  'The workspace registry and where GitHub checkouts land.': '工作区项目注册表和 GitHub 检出位置。',
  'Agents, worktrees, bookmarklets and prompt templates are per project.': 'Agent、工作树、书签脚本和提示词模板按项目配置。',
  'Default runner, models and system prompt.': '默认运行器、模型和系统提示词。',
  'How many finished task worktrees this project keeps on disk.': '此项目在磁盘上保留多少已完成任务工作树。',
  'Launch skills from a GitHub PR or issue.': '从 GitHub PR 或 Issue 启动技能。',
  'Reusable snippets for follow-up instructions.': '可复用的后续指令片段。',
  'Connect this project to Jira or Linear.': '将此项目连接到 Jira 或 Linear。',
  'Stored in ~/.cezar': '存储于 ~/.cezar',
  'Tasks done': '已完成任务', 'No tasks yet — describe one.': '还没有任务——描述一个任务吧。',
  'Active': '进行中', 'Archived': '已归档', 'Search…': '搜索…', 'Tools': '工具',
  'Loading…': '加载中…', 'Loading dashboard…': '正在加载仪表盘…', 'Loading trends…': '正在加载趋势…',
  'Starting task…': '正在启动任务…', 'Nothing matches.': '没有匹配项。', 'Configure providers': '配置 Provider',
  'Markdown playbooks agents can follow.': 'Agent 可以遵循的 Markdown 操作手册。',
  'Manage skills': '管理技能', 'Run from GitHub': '从 GitHub 运行',
  'All results': '全部结果', 'All events': '全部事件', State: '状态', Automation: '自动化',
  Trigger: '触发器', 'Runs as': '运行身份', 'Next run': '下次运行', 'Last run': '上次运行',
  'Runs 7d': '7 天运行次数', 'Cost 7d': '7 天成本', Cost: '成本', CPU: 'CPU', Mem: '内存', Age: '时间',
  Task: '任务', Project: '项目', Tags: '标签', Ref: '引用', Workflow: '工作流', Actions: '操作', References: '引用',
  Compare: '比较', 'Group by': '分组方式', 'Save as chain': '保存为工作流', Overwrite: '覆盖',
  'Keep the existing chain': '保留现有工作流', 'Back to tasks': '返回任务', Cancel: '取消', Retry: '重试',
  Refresh: '刷新', Save: '保存', Search: '搜索', Clear: '清除', 'Load more': '加载更多',
  'No scheduled runs in the next two weeks.': '未来两周没有计划任务。',
  'No reports in this period.': '此时间段没有报告。', 'No finished tasks in this period.': '此时间段没有已完成任务。',
  'No tasks finished in this period.': '此时间段没有完成任务。', Trends: '趋势', Delivered: '已交付',
  'Completed tasks': '已完成任务', 'Backends & models': '后端与模型', 'Automation outcomes': '自动化结果',
  Branches: '分支', 'Open pull requests': '开放的 Pull Request', 'No open pull requests.': '没有开放的 Pull Request。',
  'Uncommitted changes': '未提交的更改', 'Commit changes': '提交更改', 'Open this link?': '打开此链接？',
  'Open link': '打开链接', 'Keep it': '保留', 'Keep comparing': '继续比较', 'Merge status unavailable': '无法获取合并状态',
  Conversation: '对话', Changes: '更改', 'No labels.': '没有标签。', 'Changed files could not be loaded.': '无法加载更改的文件。',
  Logins: '登录', 'Defaults for new projects': '新项目默认设置',
  'Checking…': '检查中…', Yes: '是', 'Unsaved changes': '未保存的更改', 'Loading file…': '正在加载文件…',
  'No user-scoped MCP servers.': '没有用户范围的 MCP Server。', 'Could not read the file.': '无法读取文件。',
  'Agents': 'Agent', Plan: '计划', 'Working…': '工作中…', Thinking: '思考中', Answered: '已回答',
  'The agent is asking': 'Agent 正在提问', 'Review the changes before anything lands.': '在合并任何内容前先检查更改。',
  'Issue state': 'Issue 状态', 'All states': '全部状态', 'Connect an issue tracker': '连接 Issue 跟踪器',
  Overview: '概览', 'Usage & cost': '用量与成本', 'Across your workspace · Includes subtasks': '整个工作区 · 包含子任务',
  Live: '实时', Offline: '离线', Customize: '自定义', 'Optional modules in this view': '此视图中的可选模块',
  'Queue & scheduling': '队列与调度', 'Needs you': '需要你处理', 'Recent results & GitHub': '最近结果与 GitHub',
  'Drag a module by its handle. With keyboard: Space, arrow keys, Space. Escape cancels.': '拖动模块手柄调整顺序。键盘操作：空格、方向键、空格；Esc 取消。',
  'Tasks connected': '任务已连接', 'Tasks disconnected': '任务未连接', Queued: '排队中', Scheduled: '已计划', 'Technical details': '技术详情',
  'Workspace overview': '工作区概览', 'Outcomes period': '结果周期', 'Last 7 days': '最近 7 天', 'Last 30 days': '最近 30 天',
  'Loading overview…': '正在加载概览…', 'Showing previous results.': '正在显示之前的结果。', 'Could not refresh overview.': '无法刷新概览。', 'Retry overview': '重试概览',
  'Dashboard views': '仪表盘视图', Reset: '重置', order: '顺序', 'Show all in': '在此视图中显示全部', 'Last updated': '上次更新', ago: '前',
  'Running now': '正在运行', Completed: '已完成', 'Failed outcomes': '失败结果',
  'No tasks currently require your input or review.': '当前没有需要你输入或审核的任务。', 'No waiting tasks found in the available data.': '可用数据中没有等待中的任务。',
  'failed outcomes': '失败结果', 'in this period. Includes subtasks; completed does not mean accepted or deployed.': '在此期间。包含子任务；完成不代表已接受或部署。',
  'Current state': '当前状态', Last: '最近', 'calendar days': '个日历日', 'View tasks': '查看任务', 'Median cycle time': '周期中位数',
  'completed tasks have valid timings.': '个已完成任务有有效计时。', 'Inspect completed tasks': '检查已完成任务', 'How these metrics work': '这些指标如何计算',
  questions: '问题', reviews: '审核', Questions: '问题', Reviews: '审核', 'All caught up — no tasks need your input': '全部处理完毕——没有需要你输入的任务',
  'Recent results': '最近结果', 'Results source': '结果来源', All: '全部', 'Task results': '任务结果', 'No GitHub repositories configured': '未配置 GitHub 仓库',
  'GitHub needs attention': 'GitHub 需要处理', 'GitHub not configured': '未配置 GitHub', 'GitHub source': 'GitHub 来源',
  'Open tracker settings': '打开跟踪器设置', 'Retry connection': '重试连接', 'Search results could not be loaded.': '无法加载搜索结果。',
  // Personal AI OS cockpit (system-connections.tsx). User-visible surface text carries the
  // ENGLISH source string as its key; the value is the exact Chinese wording it renders today.
  'System connections': '系统连接',
  'Live boundary of the primary agent, fallback, WeChat and local apps.': '主 Agent、fallback、微信和本机 App 的实时边界',
  'Open WeChat connection': '打开微信连接',
  'View local agent channels': '查看本机 Agent 通道',
  'Manage connections': '管理连接',
  'Connect WeChat': '连接微信',
  'WeChat connected': '微信已连接',
  'WeChat Bot': '微信 Bot',
  'Shared Mem0 memory': 'Mem0 共享记忆',
  'Connected': '已连接',
  'Available': '可接入',
  'Unavailable': '不可用',
  'Local WeChat bridge is healthy': '本机微信桥正常',
  'Open settings to regenerate the QR code': '打开设置重新生成二维码',
  'Local storage · {pending} pending · {retrying} retrying': '本地存储 · 待提炼 {pending} · 重试 {retrying}',
  'Long-term retrieval is unavailable; WeChat keeps using local context': '长期检索暂不可用；微信继续使用本地上下文',
  'GUI-only; old sessions are managed by the Codex App': 'GUI-only；旧会话由 Codex App 管理',
  'Local OpenAI-compatible proxy': '本机 OpenAI-compatible 反代',
  'codebuddy --acp; old sessions need an explicit resume': 'codebuddy --acp；旧会话需显式 resume',
  'Devin ACP discovered; old sessions need an explicit resume': '已发现 Devin ACP；旧会话需显式恢复',
  'Cloud entry discovered; auth/billing unverified': '云端入口已发现；未验证认证/计费',
  'CI entry discovered; workflows not triggered': 'CI 入口已发现；未触发 workflow',
  'GUI-only; no stable CLI/ACP control channel': 'GUI-only；没有稳定 CLI/ACP 控制通道',
  'WeChat primary agent (configured)': '微信主 Agent（配置）',
  'Standalone ACP / fallback channel': '独立 ACP / fallback 通道',
  '{boundary} / old sessions available via kimi --session': '{boundary} / 旧会话可用 kimi --session',

  // Personal AI OS cockpit (continuous-goals.tsx).
  'Continuous goals · autonomous verification': '持续目标 · 自主验证',
  'Personal AI OS 0.2.0 · confirm the scope once, the agent iterates on its own, you spot-check the results': 'Personal AI OS 0.2.0 · 一次确认范围，Agent 自己迭代，你抽查结果',
  'New continuous goal': '新建持续目标',
  'The connection credential is kept only in this page session memory: never written to browser storage, the URL, logs or API responses. This is a temporary secure interface until formal desktop/app pairing exists, and it is not proof of your identity.': '连接凭据只在本次页面会话的内存中保存：不写入浏览器存储、URL、日志或接口返回。这是等待正式桌面/应用配对前的临时安全接口，不代表对本人身份的证明。',
  'Access credential (access token)': '访问凭据（access token）',
  'Access credential': '访问凭据',
  'Connect': '连接',
  'Disconnect': '断开连接',
  'Not connected: the goal service is not requested until you connect': '未连接：连接前不会请求目标服务',
  'Authentication failed': '认证失败',
  'Service unavailable': '服务不可用',
  'Verifying connection': '正在验证连接',
  'The first version fixes inside an isolated working copy and supports only fixed Node acceptance; it never overwrites the original project, deploys, or modifies native old sessions.': '首版在独立工作副本中修复，只支持固定 Node 验收；不会自动覆盖原项目、部署或修改原生旧会话。',
  'Resume all goals': '恢复全部目标',
  'Pause all goals': '暂停全部目标',
  'Goal title': '目标标题',
  'Source project directory': '源项目目录',
  'Goal objective': '完成目标',
  'Approved read files (comma-separated)': '批准读取文件（逗号分隔）',
  'Approved write files (working copy)': '批准修改文件（工作副本）',
  'Immutable acceptance file': '不可修改的验收文件',
  'Token limit': 'token 上限',
  'At most 10 rounds, 24 hours, stop after 3 rounds with no progress by default; safety checkpoints resume automatically after an interruption, at most 3 times, without raising the original budget or permissions. Kimi plans and reviews, the official DeepSeek V4.1 Flash proposes changes. Approved file contents are sent to these existing providers.': '默认最多 10 轮、24 小时、连续 3 轮无进展停止；安全检查点支持中断后自动接续，最多 3 次，不提高原预算或权限。Kimi 规划与复核，官方 DeepSeek V4.1 Flash 提出修改。获批文件内容会发送给这些现有 provider。',
  'Update draft and re-confirm scope': '更新草稿，重新确认范围',
  'Create draft and review scope first': '创建草稿，先查看范围',
  'Not connected: enter an access credential above and connect before managing continuous goals.': '未连接：请在上方输入访问凭据并连接后管理持续目标。',
  'Goal service authentication failed: the current credential was rejected, disconnect and reconnect.': '目标服务认证失败：当前凭据被拒绝，请断开后重新连接。',
  'The continuous goals service is temporarily unavailable; WeChat chat and Cezar native tasks are unaffected.': '持续目标服务暂不可用；微信聊天与 Cezar 原生任务不受影响。',
  'No continuous goals yet. Create one and confirm its scope to start.': '暂无持续目标。新建后确认范围即可启动。',
  'Round {iteration} / {maxRounds} · tokens {used} / {max}': '第 {iteration} / {maxRounds} 轮 · token {used} / {max}',
  'Interruption self-recovery: resumed {count} / {max} times; verify the scope and checkpoints first': '中断自恢复：已接续 {count} / {max} 次；先核对范围和检查点',
  'Old goal or self-recovery off: an interruption needs review, it does not rerun on its own': '旧目标或未开启自恢复：中断后需核对，不自动重跑',
  'Confirm scope and start': '确认范围并启动',
  'Pause': '暂停',
  'Resume': '恢复',
  'Change direction': '改方向',
  'Spot-check scope and acceptance record': '抽查范围与验收记录',
  'Read: ': '读取：',
  'Write: ': '修改：',
  'Fixed checks: ': '固定检查：',
  'Result copy: ': '结果副本：',
  '{name}: exit code {code}': '{name}：退出码 {code}',
  'did not finish normally': '未正常结束',
  'Not yet reviewed': '尚未复核',
  'Scope pending': '待确认范围',
  'Waiting to run': '等待下一轮',
  'Executing autonomously': '自主执行中',
  'Paused': '已暂停',
  'Cancelled': '已取消',
  'Accepted': '已完成验收',
  'Planning': '规划',
  'Chief planning': 'Chief 规划',
  'Worker proposes changes': 'Worker 提出修改',
  'Applying controlled changes': '应用受控修改',
  'Real acceptance': '真实验收',
  'Independent review': '独立复核',
  'Waiting for wake': '待唤醒',
  'Check in ~{minutes} min': '约 {minutes} 分钟后检查',
  'Check at {time}': '{time} 检查',
  'Next check: {label}': '下一检查：{label}',
  'Recovery status: pending': '恢复状态：待恢复',
  'Recovery status: auto-recovered {count} times': '恢复状态：已自动恢复 {count} 次',
  'Recovery pending': '待恢复',
  'Auto-recovered {count} times': '已自动恢复 {count} 次',
  'Automated fix verification dry run': '自动修复验证试运行',
  'Fix the add function so the addition tests for positive numbers, negatives and zero pass; do not modify the acceptance tests.': '修复 add 函数，使正数、负数和零的加法测试通过；不要修改验收测试。',
  'Fixed Node acceptance': '固定 Node 验收',
  'Invalid credential format': '访问凭据格式无效',
  'The continuous goals service is temporarily unavailable': '持续目标服务暂不可用',
  'Goal service authentication failed: the credential was rejected, reconnect with a new token': '目标服务认证失败：访问凭据被拒绝，请重新连接',
  'Connection changed — the previous result was ignored': '连接已改变，旧结果已忽略',
  'Invalid credential: a 43-character base64url token is required': '访问凭据无效：需要 43 位 base64url token',

  // Personal AI OS cockpit (control-plane-tasks.tsx).
  'Control-plane tasks': '控制面任务',
  'Personal AI OS Task / Execution state': 'Personal AI OS Task / Execution 状态',
  '{count} items': '{count} 个',
  'Reading control-plane…': '正在读取控制面…',
  "The control-plane is unavailable; Cezar's native tasks are unaffected": '控制面暂不可用；不会影响 Cezar 原生任务',
  'No control-plane tasks': '暂无控制面任务',
  'Draft': '草稿',
  'Planned': '已规划',
  'Running': '执行中',
  'Verifying': '验证中',
  'In review': 'Review 中',
  'Ready to deliver': '待交付',
  'Blocked': '已阻塞',
  'Failed': '失败',
  'Show execution details for task {id}': '展开任务 {id} 的执行详情',
  'Hide execution details for task {id}': '收起任务 {id} 的执行详情',
  '{count} executions': '{count} 次执行',

  // Personal AI OS cockpit (control-plane-executions.tsx).
  'Reviewing': '复核中',
  'Succeeded': '已成功',
  'Command': '命令',
  'Test': '测试',
  'Diff': '差异',
  'Log': '日志',
  'Screenshot': '截图',
  'Review': '复核',
  'Message': '消息',
  'Execution status: {status}': '执行状态：{status}',
  'Verdict: {verdict}': '判定：{verdict}',
  'Passed': '通过',
  'Exit code {code}': '退出码 {code}',
  'Copy {ref}': '副本 {ref}',
  'Attempt {attempt}': '第 {attempt} 次',
  'Review child · parent {id}': '复核子执行 · 父执行 {id}',
  'Evidence {count}': '证据 {count}',
  'Show evidence for execution {id}': '展开执行 {id} 的证据',
  'Hide evidence for execution {id}': '收起执行 {id} 的证据',
  'No evidence for this execution.': '该执行暂无证据。',
  'Evidence list': '证据列表',
  'Execution list': 'Execution 列表',
  'Execution list · task {id}': 'Execution 列表 · 任务 {id}',
  'Loading execution details…': '正在读取执行详情…',
  "The control-plane is unreachable; cannot read this task's execution details": '控制面暂不可达，无法读取该任务的执行详情',
  'Completion acceptance conditions': '完成验收条件',
  'Loading completion conditions…': '正在读取完成条件…',
  'Completion conditions are unreachable; cannot tell whether this task can be completed': '完成条件暂不可达，无法判断该任务是否可以完成',
  'The fixed acceptance conditions are met: every Execution has reached a terminal state, a succeeded root worker exists, and the artifactRef and independent review evidence are all present. Completing requires separate approval; this page will not trigger it.': '满足固定验收条件：全部 Execution 已进入终态，存在 succeeded 的 root worker，且 artifactRef 与独立 review 证据齐备。完成操作需另行审批，本页不会触发。',
  'Completion conditions not met yet:': '尚不满足完成条件：',
  "The control-plane gave no specific reason; check this task's execution records.": '控制面未给出具体原因，请查看该任务的执行记录。',
  'Unmet completion conditions': '未满足的完成条件',
  'Parameter digest {digest}': '参数摘要 {digest}',
  'No Execution for this task.': '该任务暂无 Execution。',

  // Personal AI OS cockpit (control-plane-approvals.tsx).
  'Pending approvals': '待审批动作',
  'Target, parameter digest and expiry are verified before approving': '批准前会校验目标、参数摘要和有效期',
  'Reject': '拒绝',
  'Approve': '批准',
  'Reject {action} · {target}': '拒绝 {action} · {target}',
  'Approve {action} · {target}': '批准 {action} · {target}',
}

type LocaleContextValue = { locale: Locale; setLocale: (locale: Locale) => void; t: (text: string) => string }
const LocaleContext = React.createContext<LocaleContextValue>({ locale: 'en', setLocale: () => {}, t: (text) => text })

function initialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'zh-CN' || stored === 'en') return stored
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  } catch { return 'en' }
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(initialLocale)
  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* read-only storage */ }
  }, [])
  React.useEffect(() => { document.documentElement.lang = locale }, [locale])
  const value = React.useMemo(() => ({ locale, setLocale, t: (text: string) => locale === 'zh-CN' ? TRANSLATIONS[text] ?? text : text }), [locale, setLocale])
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale() { return React.useContext(LocaleContext) }

/**
 * Fill `{name}` placeholders in a translated template.
 *
 *  A sentence that carries a variable is NEVER assembled by concatenating translated
 *  fragments: word order differs between the languages ("第 2 次" vs "Attempt 2"), so the
 *  WHOLE sentence — placeholders and all — is the translation key, and only the values are
 *  interpolated here. The Chinese table carries the same placeholders in its own order:
 *
 *    fill(t('Attempt {attempt}'), { attempt: 2 })   // "Attempt 2" (en) / "第 2 次" (zh-CN)
 *
 *  An unknown placeholder is left verbatim rather than blanked — a missing value should show
 *  up as `{id}` in the UI, not silently vanish.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  )
}

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLocale()
  const next = locale === 'en' ? 'zh-CN' : 'en'
  return (
    <button type="button" data-slot="language-toggle"
      className={className ?? 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'}
      title={`${t('Language')}: ${locale === 'en' ? 'English' : '中文'}`}
      aria-label={`${t('Language')}: ${locale === 'en' ? 'English' : '中文'}. Switch to ${next === 'en' ? 'English' : '中文'}.`}
      onClick={() => setLocale(next)}>
      <LanguagesIcon className="size-4" aria-hidden="true" />
      <span className="sr-only">{next === 'en' ? 'English' : '中文'}</span>
    </button>
  )
}

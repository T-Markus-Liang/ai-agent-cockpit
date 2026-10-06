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
  '系统连接': '系统连接', '本机 Agent、微信入口和模型反代的实际连接状态。': '本机 Agent、微信入口和模型反代的实际连接状态。',
  '打开微信连接': '打开微信连接', '查看本机 Agent 通道': '查看本机 Agent 通道',
  '主 Agent、fallback、微信和本机 App 的实时边界': '主 Agent、fallback、微信和本机 App 的实时边界', '管理连接': '管理连接',
  '连接微信': '连接微信', '微信已连接': '微信已连接',
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

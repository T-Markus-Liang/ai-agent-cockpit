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
  'Open tracker settings': '打开跟踪器设置', 'Retry connection': '重试连接', 'Search results could not be loaded.': '无法加载搜索结果。',
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

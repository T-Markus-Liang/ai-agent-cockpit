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

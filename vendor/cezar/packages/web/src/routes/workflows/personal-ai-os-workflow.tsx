import { ArrowDownIcon, ShieldCheckIcon, WorkflowIcon } from 'lucide-react'
import { useLocale } from '@/components/locale-provider'

type Node = { id: string; title: string; detail: string; tone: string }

// Titles and details carry the ENGLISH source string and the render layer translates each through
// `t` (see locale-provider), so a locale switch re-renders the diagram instead of leaving one
// language baked into the module. A brand or acronym name ('Chief', 'Feature Map + Router', …) is
// not in the table, so `t` returns it unchanged in every locale.
const NODES: Node[] = [
  { id: 'entry', title: 'WeChat / phone entry', detail: 'Messages, approvals, status and Evidence relayed back', tone: 'border-violet/40 bg-violet/5' },
  { id: 'chief', title: 'Chief', detail: 'Understands the goal, checks constraints, summarizes results', tone: 'border-primary/40 bg-primary/5' },
  { id: 'router', title: 'Feature Map + Router', detail: 'Capability evidence, Jev advisory, Policy gate', tone: 'border-warning/40 bg-warning/5' },
  { id: 'task', title: 'Task / Execution', detail: 'Idempotency, state machine, Session lock, audit', tone: 'border-border bg-card-2' },
  { id: 'worker', title: 'Worker adapters', detail: 'Cezar, Codex, OpenCode, Kimi, Devin, WorkBuddy', tone: 'border-success/40 bg-success/5' },
  { id: 'review', title: 'Reviewer + Verification', detail: 'Independent Review, test/command Evidence', tone: 'border-warning/40 bg-warning/5' },
  { id: 'gate', title: 'Approval / Completion Gate', detail: 'Completion or external side effects only after precise Approval', tone: 'border-danger/40 bg-danger/5' },
]

export function PersonalAiOsWorkflow() {
  const { t } = useLocale()
  return <section data-slot="personal-ai-os-workflow" className="mb-5 rounded-lg border border-border bg-card p-4 md:p-5">
    <div className="flex items-start gap-3">
      <WorkflowIcon className="mt-0.5 size-5 text-violet" aria-hidden="true" />
      <div><h2 className="text-sm font-semibold">{t('Personal AI OS control-plane workflow')}</h2><p className="mt-1 text-xs text-muted-foreground">{t('The Chief → Router → Worker → Reviewer → Verification closed loop being designed. The Cezar workflow below is still one reusable Worker chain in it.')}</p></div>
    </div>
    <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-stretch">
      {NODES.map((node, index) => <div key={node.id} className="contents">
        <div data-workflow-node={node.id} className={`rounded-md border p-3 md:min-h-24 md:flex-1 ${node.tone}`}>
          <div className="text-xs font-semibold">{t(node.title)}</div>
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{t(node.detail)}</div>
        </div>
        {index < NODES.length - 1 ? <ArrowDownIcon className="mx-auto size-4 text-muted-foreground md:hidden" aria-hidden="true" /> : null}
        {index < NODES.length - 1 ? <div className="hidden items-center justify-center text-muted-foreground md:flex" aria-hidden="true">→</div> : null}
      </div>)}
    </div>
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <ShieldCheckIcon className="size-3.5 text-warning" aria-hidden="true" />
      <span>{t('A worker reporting completion does not close the case: it must pass Verification, independent Review and precise Approval.')}</span>
    </div>
  </section>
}

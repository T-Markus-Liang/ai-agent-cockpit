import { ArrowDownIcon, ShieldCheckIcon, WorkflowIcon } from 'lucide-react'

type Node = { id: string; title: string; detail: string; tone: string }

const NODES: Node[] = [
  { id: 'entry', title: '微信 / 手机入口', detail: '消息、审批、状态、Evidence 回传', tone: 'border-violet/40 bg-violet/5' },
  { id: 'chief', title: 'Chief', detail: '理解目标、核对约束、汇总结果', tone: 'border-primary/40 bg-primary/5' },
  { id: 'router', title: 'Feature Map + Router', detail: '能力证据、Jev advisory、Policy gate', tone: 'border-warning/40 bg-warning/5' },
  { id: 'task', title: 'Task / Execution', detail: '幂等、状态机、Session lock、审计', tone: 'border-border bg-card-2' },
  { id: 'worker', title: 'Worker adapters', detail: 'Cezar、Codex、OpenCode、Kimi、Devin、WorkBuddy', tone: 'border-success/40 bg-success/5' },
  { id: 'review', title: 'Reviewer + Verification', detail: '独立 Review、test/command Evidence', tone: 'border-warning/40 bg-warning/5' },
  { id: 'gate', title: 'Approval / Completion Gate', detail: '精确 Approval 后才允许完成或外部副作用', tone: 'border-danger/40 bg-danger/5' },
]

export function PersonalAiOsWorkflow() {
  return <section data-slot="personal-ai-os-workflow" className="mb-5 rounded-lg border border-border bg-card p-4 md:p-5">
    <div className="flex items-start gap-3">
      <WorkflowIcon className="mt-0.5 size-5 text-violet" aria-hidden="true" />
      <div><h2 className="text-sm font-semibold">Personal AI OS 控制面工作流</h2><p className="mt-1 text-xs text-muted-foreground">架构设计中的 Chief → Router → Worker → Reviewer → Verification 闭环。下方的 Cezar workflow 仍是其中一个可复用 Worker 链。</p></div>
    </div>
    <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-stretch">
      {NODES.map((node, index) => <div key={node.id} className="contents">
        <div data-workflow-node={node.id} className={`rounded-md border p-3 md:min-h-24 md:flex-1 ${node.tone}`}>
          <div className="text-xs font-semibold">{node.title}</div>
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{node.detail}</div>
        </div>
        {index < NODES.length - 1 ? <ArrowDownIcon className="mx-auto size-4 text-muted-foreground md:hidden" aria-hidden="true" /> : null}
        {index < NODES.length - 1 ? <div className="hidden items-center justify-center text-muted-foreground md:flex" aria-hidden="true">→</div> : null}
      </div>)}
    </div>
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <ShieldCheckIcon className="size-3.5 text-warning" aria-hidden="true" />
      <span>Worker 自报完成不会直接结案：必须经过 Verification、独立 Review 和精确 Approval。</span>
    </div>
  </section>
}

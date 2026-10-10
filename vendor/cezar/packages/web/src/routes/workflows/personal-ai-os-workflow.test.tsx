import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider } from '@/components/locale-provider'
import { PersonalAiOsWorkflow } from './personal-ai-os-workflow'

// The diagram is fully localized (English source strings + a zh-CN table, see locale-provider).
// Force zh-CN so these assertions — written against the Chinese the diagram renders today — keep
// checking that wording byte-for-byte; the `locale=en` case has its own test below.
beforeEach(() => { window.localStorage.setItem('cez-locale', 'zh-CN') })
afterEach(() => { cleanup(); window.localStorage.clear() })

function ui() { return <LocaleProvider><PersonalAiOsWorkflow /></LocaleProvider> }

describe('Personal AI OS workflow visual', () => {
  it('renders the architecture stages without replacing Cezar workflows', () => {
    render(ui())
    expect(screen.getByText('Personal AI OS 控制面工作流')).toBeTruthy()
    for (const id of ['entry', 'chief', 'router', 'task', 'worker', 'review', 'gate']) {
      expect(document.querySelector(`[data-workflow-node="${id}"]`)).not.toBeNull()
    }
    expect(screen.getByText(/Worker 自报完成不会直接结案/)).toBeTruthy()
  })

  it('renders the same Chinese wording for the node titles and details under locale=zh-CN', () => {
    render(ui())
    expect(screen.getByText('微信 / 手机入口')).toBeTruthy()
    expect(screen.getByText('消息、审批、状态、Evidence 回传')).toBeTruthy()
    expect(screen.getByText('独立 Review、test/command Evidence')).toBeTruthy()
    expect(screen.getByText('架构设计中的 Chief → Router → Worker → Reviewer → Verification 闭环。下方的 Cezar workflow 仍是其中一个可复用 Worker 链。')).toBeTruthy()
  })

  it('renders the English source strings under locale=en', () => {
    window.localStorage.setItem('cez-locale', 'en')
    render(ui())
    expect(screen.getByText('Personal AI OS control-plane workflow')).toBeTruthy()
    expect(screen.getByText('WeChat / phone entry')).toBeTruthy()
    expect(screen.getByText('Messages, approvals, status and Evidence relayed back')).toBeTruthy()
    expect(screen.getByText(/A worker reporting completion does not close the case/)).toBeTruthy()
  })
})

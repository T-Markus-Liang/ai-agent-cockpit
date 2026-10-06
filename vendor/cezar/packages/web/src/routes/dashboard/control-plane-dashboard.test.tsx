import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { LocaleProvider } from '@/components/locale-provider'
import { ControlPlaneApprovals } from './control-plane-approvals'
import { ControlPlaneTasks } from './control-plane-tasks'

function renderWithQuery(ui: React.ReactElement) {
  const client = createQueryClient()
  return render(<LocaleProvider><QueryClientProvider client={client}>{ui}</QueryClientProvider></LocaleProvider>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Personal AI OS dashboard modules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/control-plane/tasks')) return new Response(JSON.stringify({ tasks: [{ id: 'task_1', goal: '修复控制面', status: 'running', updatedAt: '2026-10-06T00:00:00Z', executionIds: ['execution_1'] }] }), { status: 200 })
      if (url.includes('/api/control-plane/approvals/') && init?.method === 'POST') return new Response(JSON.stringify({ approval: { decision: 'approved' } }), { status: 200 })
      if (url.includes('/api/control-plane/approvals')) return new Response(JSON.stringify({ approvals: [{ id: 'approval_1', action: 'cezar.dispatch', target: 'execution_1', parametersDigest: 'sha256:test', decision: 'pending', createdAt: '2026-10-06T00:00:00Z' }] }), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
  })

  it('renders live control-plane task state', async () => {
    renderWithQuery(<ControlPlaneTasks />)
    expect(await screen.findByText('修复控制面')).toBeTruthy()
    expect(screen.getByText('执行中')).toBeTruthy()
    expect(screen.getByText(/1 次执行/)).toBeTruthy()
  })

  it('renders pending approval and sends a decision through the API', async () => {
    renderWithQuery(<ControlPlaneApprovals />)
    expect(await screen.findByText('cezar.dispatch · execution_1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /批准/ }))
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(([, init]) => init?.method === 'POST' && String(init?.body).includes('approved'))).toBe(true)
    })
  })
})

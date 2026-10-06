import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PersonalAiOsWorkflow } from './personal-ai-os-workflow'

afterEach(cleanup)

describe('Personal AI OS workflow visual', () => {
  it('renders the architecture stages without replacing Cezar workflows', () => {
    render(<PersonalAiOsWorkflow />)
    expect(screen.getByText('Personal AI OS 控制面工作流')).toBeTruthy()
    for (const id of ['entry', 'chief', 'router', 'task', 'worker', 'review', 'gate']) {
      expect(document.querySelector(`[data-workflow-node="${id}"]`)).not.toBeNull()
    }
    expect(screen.getByText(/Worker 自报完成不会直接结案/)).toBeTruthy()
  })
})


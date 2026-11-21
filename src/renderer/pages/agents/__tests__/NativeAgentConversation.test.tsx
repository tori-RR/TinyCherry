import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

const runtime = vi.hoisted(() => ({
  messages: [],
  send: vi.fn().mockResolvedValue(true),
  stop: vi.fn(),
  respond: vi.fn(),
  refresh: vi.fn(),
  isRunning: false,
  isSubmitting: false,
  isLoading: false,
  hasOlder: false,
  isLoadingOlder: false,
  loadOlder: vi.fn()
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
vi.mock('@renderer/components/markdown', () => ({
  AppMarkdown: ({ children }: { children: ReactNode }) => children,
  MarkdownHostProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../useNativeAgentSession', () => ({ useNativeAgentSession: () => runtime }))
vi.mock('../nativeAgentMessages', () => ({
  readNativeAgentDraft: () => ({ text: '' }),
  writeNativeAgentDraft: vi.fn()
}))

import { NativeAgentConversation } from '../NativeAgentConversation'

class TestBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? <pre role="alert">{this.state.error.message}</pre> : this.props.children
  }
}

const agent = {
  id: 'worker',
  type: 'native',
  name: 'Native worker',
  model: 'provider::work-model',
  configuration: { permission_mode: 'default' }
} as AgentEntity
const session = {
  id: 'session',
  agentId: agent.id,
  name: 'Local work',
  workspace: { id: 'workspace', name: 'Local workspace', type: 'system', path: '/workspace/test' }
} as AgentSessionEntity

beforeEach(() => {
  MockUsePreferenceUtils.resetMocks()
})

it('upgrades the cold textarea to the real rich editor without leaving the Work conversation', async () => {
  const { container } = render(
    <TestBoundary>
      <NativeAgentConversation session={session} agent={agent} onEdit={() => {}} />
    </TestBoundary>
  )
  const fallback = container.querySelector('[data-testid="agent-composer"] textarea')
  expect(fallback).toBeInstanceOf(HTMLTextAreaElement)
  fireEvent.focus(fallback!)
  await act(() => vi.dynamicImportSettled())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  await waitFor(() => {
    expect(container.querySelector('[data-testid="agent-composer"] [contenteditable="true"]')).toBeInTheDocument()
  })
  expect(screen.getByTestId('agent-conversation')).toBeInTheDocument()
})

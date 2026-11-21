import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DynamicToolUIPart } from 'ai'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { NativeAgentToolCard } from '../NativeAgentConversation'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }))
vi.mock('@cherrystudio/ui', () => ({
  Button: ({
    children,
    loading,
    variant,
    size,
    ...props
  }: {
    children: ReactNode
    loading?: boolean
    variant?: string
    size?: string
  }) => (
    <button
      {...props}
      data-variant={variant}
      data-size={size}
      disabled={loading || (props as { disabled?: boolean }).disabled}>
      {children}
    </button>
  ),
  Tooltip: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/components/composer/ComposerSurface', () => ({ default: () => null }))
vi.mock('@renderer/components/markdown', () => ({
  AppMarkdown: ({ children }: { children: ReactNode }) => children,
  MarkdownHostProvider: ({ children }: { children: ReactNode }) => children
}))
vi.mock('@renderer/services/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../useNativeAgentSession', () => ({ useNativeAgentSession: vi.fn() }))
vi.mock('../nativeAgentMessages', () => ({
  readNativeAgentDraft: () => ({ text: '' }),
  writeNativeAgentDraft: vi.fn()
}))

const request: DynamicToolUIPart = {
  type: 'dynamic-tool',
  toolName: 'run_shell',
  toolCallId: 'tool-1',
  state: 'approval-requested',
  input: { command: 'printf "hello"', cwd: 'model-supplied-relative-path' },
  approval: { id: 'approval-1' },
  callProviderMetadata: {
    cherry: { toolSource: 'native', resolvedCwd: '/verified/workspace', workspacePath: '/verified', hostShell: true }
  }
}

describe('native tool approval', () => {
  it('shows the exact command and backend-resolved cwd, then sends only one explicit decision', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    render(<NativeAgentToolCard part={request} messageId="message-1" canApprove onRespond={respond} />)
    expect(screen.getByText('/verified/workspace')).toBeInTheDocument()
    expect(screen.getByText(/printf/)).toBeInTheDocument()
    expect(screen.getByText(/当前用户权限/)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('agent-tool-approve'))
    await waitFor(() => expect(respond).toHaveBeenCalledWith('approval-1', 'message-1', true))
    await waitFor(() => expect(screen.getByTestId('agent-tool-approve')).toBeDisabled())
    fireEvent.click(screen.getByTestId('agent-tool-approve'))
    expect(respond).toHaveBeenCalledTimes(1)
  })

  it('preserves the approval and the failure message when delivery fails', async () => {
    const respond = vi.fn().mockRejectedValue(new Error('approval delivery failed'))
    render(<NativeAgentToolCard part={request} messageId="message-2" canApprove onRespond={respond} />)
    fireEvent.click(screen.getByTestId('agent-tool-reject'))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent('approval delivery failed')
    expect(respond).toHaveBeenCalledWith('approval-1', 'message-2', false)
    expect(screen.getByTestId('agent-tool-reject')).toBeEnabled()
  })

  it('cannot approve a historical request after its execution has stopped', () => {
    const respond = vi.fn()
    render(<NativeAgentToolCard part={request} messageId="message-3" canApprove={false} onRespond={respond} />)
    expect(screen.getByTestId('agent-tool-approve')).toBeDisabled()
    expect(screen.getByTestId('agent-tool-reject')).toBeDisabled()
    fireEvent.click(screen.getByTestId('agent-tool-approve'))
    expect(respond).not.toHaveBeenCalled()
  })
})

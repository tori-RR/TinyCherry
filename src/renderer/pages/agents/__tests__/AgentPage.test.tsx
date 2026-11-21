import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  agents: [] as Array<Record<string, unknown>>,
  search: {} as { agentId?: string; sessionId?: string }
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key })
}))
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({ useSearch: () => state.search }),
  useNavigate: () => state.navigate
}))
vi.mock('@renderer/data/hooks/useDataApi', () => ({
  useDataChange: vi.fn(),
  useInvalidateCache: () => state.refresh,
  useInfiniteFlatItems: () => [],
  useInfiniteQuery: () => ({ pages: [], isLoading: false, hasNext: false, refresh: state.refresh }),
  useQuery: (path: string) => ({
    data: path === '/agent-workspaces' ? [] : path === '/agents' ? { items: [] } : { session: null },
    isLoading: false,
    isRefreshing: false,
    refetch: state.refresh
  })
}))
vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgent: () => ({ agent: undefined }),
  useAgents: () => ({ agents: state.agents, isLoading: false, refetch: state.refresh })
}))
vi.mock('@renderer/hooks/agent/useSession', () => ({
  useSession: () => ({ session: undefined, isLoading: false, mutate: state.refresh })
}))
vi.mock('../NativeAgentConversation', () => ({ NativeAgentConversation: () => null }))
vi.mock('../NativeAgentEditor', () => ({ NativeAgentEditor: () => <div data-testid="agent-editor" /> }))
vi.mock('@renderer/components/popups/PromptPopup', () => ({ default: { show: vi.fn() } }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('@renderer/services/toast', () => ({ toast: { error: vi.fn() } }))

import AgentPage from '../AgentPage'

beforeEach(() => {
  state.agents = []
  state.search = {}
  state.navigate.mockReset()
})

it('renders an empty Work page with real controls and opens the create editor', () => {
  render(<AgentPage />)
  expect(screen.getByTestId('agent-page')).toBeInTheDocument()
  expect(screen.getByText('让智能体帮你完成工作')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('agent-create'))
  expect(screen.getByTestId('agent-editor')).toBeInTheDocument()
})

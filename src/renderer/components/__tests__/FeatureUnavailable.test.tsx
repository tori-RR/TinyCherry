import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { FeatureUnavailable } from '../FeatureUnavailable'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const routes = import.meta.glob('../../routes/**/*.{ts,tsx}')
const sources = import.meta.glob('../../routes/**/*.{ts,tsx}', { query: '?raw', import: 'default' })
it('retains saved route query parameters and shows explicit pending state', async () => {
  let count = 0
  for (const [path, load] of Object.entries(routes)) {
    if (path.includes('__tests__')) continue
    if (!String(await sources[path]()).includes('component: FeatureUnavailable')) continue
    const module = (await load()) as {
      Route?: { options: { component?: unknown; validateSearch?: (search: Record<string, unknown>) => unknown } }
    }
    if (module.Route?.options.component !== FeatureUnavailable) continue
    const search = path.endsWith('/app/agents.tsx')
      ? { agentId: 'fixture-agent', sessionId: 'fixture-session', intent: 'skill', skillId: 'fixture-skill' }
      : { id: 'synthetic-saved-link', scope: 'local' }
    expect(module.Route.options.validateSearch?.(search)).toEqual(search)
    count++
  }
  expect(count).toBeGreaterThan(30)
  render(<FeatureUnavailable />)
  expect(screen.getByRole('status')).toHaveTextContent('desktop.feature_unavailable')
  expect(screen.queryByRole('button')).toBeNull()
})

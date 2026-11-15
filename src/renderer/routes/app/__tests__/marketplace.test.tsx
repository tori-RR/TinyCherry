import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { Route as MarketplaceRoute } from '../marketplace'

const runtime = vi.hoisted(() => ({ isEvoStack: false }))
vi.mock('@renderer/utils/platform', () => ({
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('@renderer/pages/marketplace/MarketplacePage', () => ({
  default: function MarketplacePage() {
    useEffect(() => {
      void ipcApi.request('skill.marketplace.list', { offset: 0, limit: 100 })
    }, [])
    return <h1>Marketplace</h1>
  }
}))

async function openMarketplace(initialEntry: string) {
  const root = createRootRoute()
  const marketplace = createRoute({
    getParentRoute: () => root,
    path: '/app/marketplace',
    beforeLoad: () => (MarketplaceRoute.options.beforeLoad as () => void)(),
    validateSearch: MarketplaceRoute.options.validateSearch,
    component: MarketplaceRoute.options.component
  })
  const skills = createRoute({
    getParentRoute: () => root,
    path: '/settings/skills',
    component: () => <h1>Local Skills</h1>
  })
  const router = createRouter({
    routeTree: root.addChildren([marketplace, skills]),
    history: createMemoryHistory({ initialEntries: [initialEntry] })
  })
  await act(() => router.load())
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  runtime.isEvoStack = false
  vi.clearAllMocks()
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('marketplace runtime boundary', () => {
  it.each(['/app/marketplace', '/app/marketplace?mcpView=sources'])(
    'redirects the native direct route before mounting unsupported catalog requests: %s',
    async (url) => {
      runtime.isEvoStack = true
      const router = await openMarketplace(url)

      expect(await screen.findByRole('heading', { name: 'Local Skills' })).toBeVisible()
      expect(router.state.location.pathname).toBe('/settings/skills')
      expect(screen.queryByRole('heading', { name: 'Marketplace' })).not.toBeInTheDocument()
      expect(ipcApi.request).not.toHaveBeenCalled()
    }
  )

  it('preserves the Electron marketplace and its catalog producer', async () => {
    const router = await openMarketplace('/app/marketplace')

    expect(await screen.findByRole('heading', { name: 'Marketplace' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/app/marketplace')
    expect(ipcApi.request).toHaveBeenCalledExactlyOnceWith('skill.marketplace.list', { offset: 0, limit: 100 })
  })
})

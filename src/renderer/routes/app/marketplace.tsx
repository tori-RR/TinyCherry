import { createFileRoute, redirect } from '@tanstack/react-router'
import * as z from 'zod'

import MarketplacePage from '@renderer/pages/marketplace/MarketplacePage'
import { isEvoStack } from '@renderer/utils/platform'

export const Route = createFileRoute('/app/marketplace')({
  validateSearch: z.object({
    mcpView: z.enum(['curated', 'sources']).optional(),
    mcpProvider: z.enum(['bailian', 'modelscope']).optional()
  }),
  beforeLoad: () => {
    if (isEvoStack) throw redirect({ to: '/settings/skills', replace: true })
  },
  component: MarketplacePage
})

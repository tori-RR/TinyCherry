import { createFileRoute } from '@tanstack/react-router'

import { FeatureUnavailable } from '@renderer/components/FeatureUnavailable'
import { parseAgentRouteSearch } from '@renderer/pages/agents/routeSearch'
export const Route = createFileRoute('/app/agents')({
  validateSearch: parseAgentRouteSearch,
  component: FeatureUnavailable
})

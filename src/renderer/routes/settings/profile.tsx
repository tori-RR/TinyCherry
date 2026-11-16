import { createFileRoute } from '@tanstack/react-router'

import { FeatureUnavailable } from '@renderer/components/FeatureUnavailable'
export const Route = createFileRoute('/settings/profile')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: FeatureUnavailable
})

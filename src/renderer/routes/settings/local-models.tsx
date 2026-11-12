import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/local-models')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

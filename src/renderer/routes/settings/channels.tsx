import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/channels')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

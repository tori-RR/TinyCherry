import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/device-connections')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

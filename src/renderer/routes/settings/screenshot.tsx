import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/screenshot')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

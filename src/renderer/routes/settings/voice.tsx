import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/voice')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

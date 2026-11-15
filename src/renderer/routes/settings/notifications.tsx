import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/notifications')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/general', replace: true })
  }
})

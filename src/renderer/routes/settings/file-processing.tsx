import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/file-processing')({
  beforeLoad: () => {
    throw redirect({ to: '/settings/provider', replace: true })
  }
})

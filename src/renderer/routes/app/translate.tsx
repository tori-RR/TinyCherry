import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/app/translate')({
  beforeLoad: () => {
    throw redirect({ to: '/app/launchpad', replace: true })
  }
})

import { createFileRoute } from '@tanstack/react-router'

import PaintingPage from '@renderer/pages/paintings/PaintingPage'
export const Route = createFileRoute('/app/paintings/$')({
  validateSearch: (search: Record<string, unknown>) => search,
  component: PaintingPage
})

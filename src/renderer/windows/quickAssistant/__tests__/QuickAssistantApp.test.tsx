import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import QuickAssistantApp from '../QuickAssistantApp'

// Cut the heavy content import graph; the wiring under test is the boundary
// around the providers. The pre-existing INNER ErrorBoundary sits inside
// ThemeProvider/CodeStyleProvider and cannot catch this throw.
vi.mock('../home/HomeWindow', () => ({ default: () => null }))

const state = vi.hoisted(() => ({ throwTheme: true }))

vi.mock('@renderer/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => {
    if (state.throwTheme) throw new Error('theme provider boom')
    return children
  }
}))

vi.mock('@renderer/components/CodeStyleProvider', () => ({
  CodeStyleProvider: ({ children }: { children: ReactNode }) => children
}))

vi.mock('@renderer/components/PopupHost', () => ({ PopupHost: () => null }))
vi.mock('@renderer/components/ToastHost', () => ({ default: () => null }))
vi.mock('@renderer/hooks/useCustomCss', () => ({ useCustomCss: vi.fn() }))
vi.mock('@renderer/hooks/useLanguageSync', () => ({ useLanguageSync: vi.fn() }))

describe('QuickAssistantApp top-level error boundary', () => {
  beforeEach(() => {
    state.throwTheme = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the window fatal fallback instead of a white screen when a provider throws', () => {
    render(<QuickAssistantApp />)

    expect(screen.getByRole('alert')).toHaveTextContent('theme provider boom')
  })

  it('keeps playback controls out of the quick-assistant shell', () => {
    state.throwTheme = false

    render(<QuickAssistantApp />)

    expect(screen.queryByLabelText('Voice playback')).not.toBeInTheDocument()
  })
})

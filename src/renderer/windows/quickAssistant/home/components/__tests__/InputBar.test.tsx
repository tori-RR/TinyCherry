import { act, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('@cherrystudio/ui')

import InputBar from '../InputBar'

describe('InputBar', () => {
  afterEach(() => vi.useRealTimers())
  it('exposes the real text input so callers can capture its live selection', () => {
    const inputRef: RefObject<HTMLInputElement | null> = { current: null }

    render(
      <InputBar
        text="draft"
        placeholder="Ask a model"
        loading
        inputRef={inputRef}
        handleKeyDown={vi.fn()}
        handleChange={vi.fn()}
      />
    )

    const input = screen.getByPlaceholderText('Ask a model') as HTMLInputElement
    input.setSelectionRange(1, 4)

    expect(inputRef.current).toBe(input)
    expect(inputRef.current?.selectionStart).toBe(1)
    expect(inputRef.current?.selectionEnd).toBe(4)
  })

  it('restores input focus when generation finishes and cancels pending focus on loading', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const props = { text: 'draft', placeholder: 'Ask', handleKeyDown: vi.fn(), handleChange: vi.fn() }
    const view = render(
      <>
        <button type="button">Elsewhere</button>
        <InputBar {...props} loading={false} />
      </>
    )
    screen.getByRole('button', { name: 'Elsewhere' }).focus()
    view.rerender(
      <>
        <button type="button">Elsewhere</button>
        <InputBar {...props} loading />
      </>
    )
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
    view.rerender(
      <>
        <button type="button">Elsewhere</button>
        <InputBar {...props} loading={false} />
      </>
    )
    act(() => {
      vi.runOnlyPendingTimers()
    })
    expect(screen.getByRole('textbox')).toHaveFocus()
  })
})

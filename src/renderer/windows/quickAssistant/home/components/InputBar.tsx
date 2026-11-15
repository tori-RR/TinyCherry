import React, { useEffect, useRef } from 'react'

import { Input } from '@cherrystudio/ui'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { useTimer } from '@renderer/hooks/useTimer'
import type { Model } from '@shared/data/types/model'

interface InputBarProps {
  text: string
  model?: Model
  placeholder: string
  loading: boolean
  inputRef?: React.RefObject<HTMLInputElement | null>
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  handleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

const InputBar = ({
  ref,
  text,
  model,
  placeholder,
  loading,
  inputRef,
  handleKeyDown,
  handleChange
}: InputBarProps & { ref?: React.RefObject<HTMLDivElement | null> }) => {
  const localInputRef = useRef<HTMLInputElement>(null)
  const resolvedInputRef = inputRef ?? localInputRef
  const { setTimeoutTimer } = useTimer()
  useEffect(() => {
    if (loading) return undefined
    return setTimeoutTimer('focus', () => resolvedInputRef.current?.focus(), 0)
  }, [loading, resolvedInputRef, setTimeoutTimer])

  return (
    <div ref={ref} className="mt-2.5 flex items-center gap-2 [-webkit-app-region:no-drag]">
      {model && <ModelAvatar model={model} size={30} />}
      <Input
        ref={resolvedInputRef}
        value={text}
        placeholder={placeholder}
        autoFocus
        onKeyDown={handleKeyDown}
        onChange={handleChange}
        className="placeholder:text-muted-foreground h-auto rounded-none border-0 bg-transparent px-0 py-0 text-lg shadow-none [-webkit-app-region:no-drag] focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
    </div>
  )
}
InputBar.displayName = 'InputBar'

export default InputBar

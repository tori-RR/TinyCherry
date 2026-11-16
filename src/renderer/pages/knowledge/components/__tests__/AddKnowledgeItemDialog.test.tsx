import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'

import AddKnowledgeItemDialog from '../AddKnowledgeItemDialog'

const mockSubmitKnowledgeItems = vi.fn()
const mockUseKnowledgePage = vi.fn()
const mockUseAddKnowledgeItems = vi.fn()
const mockFileSelect = vi.fn()
const mockSelectFolder = vi.fn()
const mockGetPathForFile = vi.fn()
const mockReadExternal = vi.fn()
const mockUseDirectoryTree = vi.fn()
const mockProjectNotesTree = vi.fn()
const mockInvalidateCache = vi.fn()
const runtime = vi.hoisted(() => ({ isEvoStack: false }))

vi.mock(import('@renderer/utils/platform'), async (importOriginal) => ({
  ...(await importOriginal()),
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

// Native picker returns FileMetadata; only `path` + `origin_name`/`name` are read downstream.

vi.mock('../../KnowledgePageProvider', () => ({
  useKnowledgePage: () => mockUseKnowledgePage()
}))

vi.mock('@renderer/hooks/useKnowledgeItems', () => ({
  useAddKnowledgeItems: (...args: unknown[]) => mockUseAddKnowledgeItems(...args)
}))

vi.mock('@data/hooks/useDataApi', () => ({
  useInvalidateCache: () => mockInvalidateCache
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: vi.fn(async (route: string, handle?: { path?: string }) => {
      if (route !== 'file.get_metadata') {
        return undefined
      }
      const path = handle?.path
      if (!path || path.includes('missing')) {
        return null
      }
      if (path.includes('directory')) {
        return {
          kind: 'directory',
          size: 0,
          createdAt: 0,
          modifiedAt: 0
        }
      }
      return {
        kind: 'file',
        type: 'document',
        mime: 'application/pdf',
        size: 1024,
        createdAt: 0,
        modifiedAt: 0
      }
    })
  }
}))

// The note picker's real data layer (useNotesSettings → NotesService → @renderer/utils)
// pulls in the i18n bootstrap at module load, which throws under the react-i18next mock.
// Stub the three note modules so the dialog graph stays bootstrap-free and the note list
// is fully controllable from each test.
vi.mock('@renderer/hooks/useNotesSettings', () => ({
  useNotesSettings: () => ({ notesPath: '/notes' })
}))

vi.mock('@renderer/hooks/useDirectoryTree', () => ({
  useDirectoryTree: () => mockUseDirectoryTree()
}))

vi.mock('@renderer/services/NotesService', () => ({
  projectNotesTree: () => mockProjectNotesTree()
}))

// The real RichEditor boots Tiptap (and its extension graph) on mount, which is far more
// than this dialog's contract needs. Stand in a textarea that speaks the same
// `initialContent` / `onMarkdownChange` protocol.
vi.mock('@renderer/components/RichEditor/RichEditor', () => ({
  default: ({
    initialContent,
    placeholder,
    onMarkdownChange,
    enableImageInsertion
  }: {
    initialContent?: string
    placeholder?: string
    onMarkdownChange?: (markdown: string) => void
    enableImageInsertion?: boolean
  }) => (
    <textarea
      defaultValue={initialContent}
      placeholder={placeholder}
      data-images-enabled={enableImageInsertion ?? true}
      onChange={(event) => onMarkdownChange?.(event.target.value)}
    />
  )
}))

vi.mock('@cherrystudio/ui', async () => {
  const React = await import('react')

  const DialogContext = React.createContext<{ onOpenChange: (open: boolean) => void; open: boolean }>({
    onOpenChange: () => undefined,
    open: false
  })

  return {
    Button: ({
      children,
      type = 'button',
      ...props
    }: {
      children: React.ReactNode
      loading?: boolean
      type?: 'button' | 'submit' | 'reset'
      [key: string]: unknown
    }) => (
      <button type={type} {...props}>
        {children}
      </button>
    ),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <label {...props}>{children}</label>
    ),
    SegmentedControl: ({
      options,
      value,
      onValueChange
    }: {
      options: { value: string; label: React.ReactNode }[]
      value?: string
      onValueChange?: (value: string) => void
    }) => (
      <div role="radiogroup">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onValueChange?.(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    ),
    Checkbox: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked?: boolean
      onCheckedChange?: (checked: boolean) => void
      [key: string]: unknown
    }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
        {...props}
      />
    ),
    Dialog: ({
      children,
      open,
      onOpenChange
    }: {
      children: React.ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => <DialogContext value={{ open, onOpenChange }}>{children}</DialogContext>,
    DialogClose: ({
      asChild,
      children,
      ...props
    }: {
      asChild?: boolean
      children: React.ReactElement<{ onClick?: (event: React.MouseEvent<HTMLElement>) => void }>
      [key: string]: unknown
    }) => {
      const { onOpenChange } = React.use(DialogContext)

      if (asChild) {
        return (
          <span role="presentation" {...props} onClick={() => onOpenChange(false)}>
            {children}
          </span>
        )
      }

      return (
        <button type="button" {...props}>
          {children}
        </button>
      )
    },
    DialogContent: ({
      children,
      size,
      ...props
    }: {
      children: React.ReactNode
      showCloseButton?: boolean
      size?: string
      [key: string]: unknown
    }) => {
      const { open } = React.use(DialogContext)
      const dialogProps = { ...props }
      delete dialogProps.closeOnOverlayClick
      delete dialogProps.showCloseButton

      return open ? (
        <div role="dialog" data-size={size} {...dialogProps}>
          {children}
        </div>
      ) : null
    },
    DialogFooter: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    DialogHeader: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <div {...props}>{children}</div>
    ),
    DialogTitle: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <h1 {...props}>{children}</h1>
    ),
    DialogDescription: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
      <p {...props}>{children}</p>
    )
  }
})

vi.mock('react-i18next', () => {
  // A single stable `t` reference (like the real react-i18next), so effects that depend
  // on `t` are not re-triggered every render.
  const t = (key: string, options?: { count?: number; defaultValue?: string; file_types?: string }) => {
    const translations = {
      'common.add': '添加',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.delete': '删除',
      'common.select_all': '全选',
      'knowledge.data_source.add_dialog.conflict_dialog.title': '存在同名数据源',
      'knowledge.data_source.add_dialog.conflict_dialog.description': `有 ${options?.count ?? 0} 个数据源与知识库中已存在的项目同名，请选择处理方式。`,
      'knowledge.data_source.add_dialog.conflict_dialog.keep_all': '全部保留',
      'knowledge.data_source.add_dialog.conflict_dialog.replace': '替换',
      'knowledge.data_source.add_dialog.footer.selected_notes': `已选 ${options?.count ?? 0} 个笔记`,
      'knowledge.data_source.add_dialog.note.description': '选择已有笔记作为知识库数据源',
      'knowledge.data_source.add_dialog.note.empty_description': '请先在「笔记」功能中创建笔记，再回到这里选择。',
      'knowledge.data_source.add_dialog.note.empty_title': '未找到笔记',
      'knowledge.data_source.add_dialog.note.loading': '正在加载笔记…',
      'knowledge.data_source.add_dialog.note.mode.import': '导入笔记',
      'knowledge.data_source.add_dialog.note.mode.create': '新建笔记',
      'knowledge.data_source.add_dialog.note.create.title_label': '标题',
      'knowledge.data_source.add_dialog.note.create.title_placeholder': '为这篇笔记取个名字',
      'knowledge.data_source.add_dialog.note.create.content_placeholder': '在此输入笔记内容…',
      'notes.tree_load_failed': '加载笔记目录失败',
      'knowledge.data_source.add_dialog.sources.directory': '目录',
      'knowledge.data_source.add_dialog.sources.file': '文件',
      'knowledge.data_source.add_dialog.sources.note': '笔记',
      'knowledge.data_source.add_dialog.sources.url': '链接',
      'knowledge.data_source.add_dialog.submit.error': '添加数据源失败',
      'knowledge.data_source.add_dialog.title': '添加数据源',
      'knowledge.data_source.add_dialog.unsupported_files_skipped': `已跳过 ${options?.count ?? 0} 个不支持的文件`,
      'chat.save.knowledge.error.file_partial_failed': `${options?.count ?? 0} file(s) could not be saved`,
      'knowledge.data_source.add_dialog.url.description': '输入网页链接：',
      'knowledge.data_source.add_dialog.url.help': '将自动抓取页面文本并分块索引',
      'knowledge.data_source.add_dialog.url.placeholder': 'https://example.com'
    } satisfies Record<string, string>

    return translations[key] ?? options?.defaultValue ?? key
  }

  return { useTranslation: () => ({ t }) }
})

describe('AddKnowledgeItemDialog', () => {
  beforeEach(() => {
    runtime.isEvoStack = false
    vi.clearAllMocks()
    mockInvalidateCache.mockResolvedValue(undefined)
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'file' })
    mockUseAddKnowledgeItems.mockReturnValue({
      submit: mockSubmitKnowledgeItems,
      isSubmitting: false,
      error: undefined
    })
    mockSubmitKnowledgeItems.mockResolvedValue({ status: 'added' })
    // Default: picker cancelled, so a render that does not arrange a selection just closes.
    mockFileSelect.mockResolvedValue(null)
    mockSelectFolder.mockResolvedValue(null)
    mockGetPathForFile.mockImplementation((file: File) => `/external/${file.name}`)
    mockUseDirectoryTree.mockReturnValue({ root: {}, isLoading: false, error: null })
    mockProjectNotesTree.mockReturnValue([])
    ;(window as any).api = {
      file: {
        select: mockFileSelect,
        selectFolder: mockSelectFolder,
        getPathForFile: mockGetPathForFile,
        readExternal: mockReadExternal
      }
    }
  })

  it('imports an EvoStack text file without Electron path APIs', async () => {
    runtime.isEvoStack = true
    const file = new File(['knowledge content'], 'notes.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: async () => 'knowledge content' })
    mockUseKnowledgePage.mockReturnValue({
      selectedBaseId: 'base-1',
      pendingAddSource: 'file',
      pendingAddFiles: [file]
    })
    const onOpenChange = vi.fn()
    render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('knowledge.import_text', {
        baseId: 'base-1',
        name: 'notes.md',
        content: 'knowledge content'
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(mockFileSelect).not.toHaveBeenCalled()
    expect(mockGetPathForFile).not.toHaveBeenCalled()
    expect(mockSubmitKnowledgeItems).not.toHaveBeenCalled()
    expect(mockInvalidateCache).toHaveBeenCalledExactlyOnceWith(['/knowledge-bases/base-1/items', '/knowledge-bases'])
  })

  it('refreshes native imported files even when a later file fails', async () => {
    runtime.isEvoStack = true
    const files = ['first.md', 'second.md'].map((name) => {
      const file = new File(['knowledge content'], name, { type: 'text/markdown' })
      Object.defineProperty(file, 'text', { value: async () => 'knowledge content' })
      return file
    })
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'file', pendingAddFiles: files })
    vi.mocked(ipcApi.request).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second import failed'))
    const onOpenChange = vi.fn()
    render(<AddKnowledgeItemDialog open onOpenChange={onOpenChange} />)

    await waitFor(() =>
      expect(mockInvalidateCache).toHaveBeenCalledExactlyOnceWith(['/knowledge-bases/base-1/items', '/knowledge-bases'])
    )
    expect(ipcApi.request).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('second import failed'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('rejects unsupported EvoStack files before importing any of a selection', async () => {
    runtime.isEvoStack = true
    const files = [new File(['text'], 'notes.md'), new File(['pdf'], 'document.pdf')]
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'file', pendingAddFiles: files })
    render(<AddKnowledgeItemDialog open onOpenChange={vi.fn()} />)

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('knowledge.evostack.text_sources_only'))
    )
    expect(ipcApi.request).not.toHaveBeenCalled()
    expect(mockGetPathForFile).not.toHaveBeenCalled()
    expect(mockInvalidateCache).not.toHaveBeenCalled()
  })
  it('submits a trimmed URL from the native URL panel', async () => {
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'url' })
    const close = vi.fn(),
      user = userEvent.setup()
    render(<AddKnowledgeItemDialog open onOpenChange={close} />)
    await user.type(screen.getByPlaceholderText('https://example.com'), ' https://example.com/docs ')
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() =>
      expect(mockSubmitKnowledgeItems).toHaveBeenCalledWith(
        [{ type: 'url', data: { source: 'https://example.com/docs', url: 'https://example.com/docs' } }],
        'detect'
      )
    )
    expect(close).toHaveBeenCalledWith(false)
  })
  it('retains the URL and dialog on failure and permits an explicit retry', async () => {
    mockUseKnowledgePage.mockReturnValue({ selectedBaseId: 'base-1', pendingAddSource: 'url' })
    mockSubmitKnowledgeItems.mockRejectedValueOnce(Error('synthetic import failure'))
    const close = vi.fn(),
      user = userEvent.setup()
    render(<AddKnowledgeItemDialog open onOpenChange={close} />)
    const input = screen.getByPlaceholderText('https://example.com')
    await user.type(input, 'https://example.com/docs')
    await user.click(screen.getByRole('button', { name: '添加' }))
    expect(await screen.findByText(/synthetic import failure/)).toBeVisible()
    expect(input).toHaveValue('https://example.com/docs')
    expect(close).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith(false))
    expect(mockSubmitKnowledgeItems).toHaveBeenCalledTimes(2)
  })
})

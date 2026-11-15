import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent } from '@cherrystudio/ui'
import { useInvalidateCache } from '@data/hooks/useDataApi'
import { loggerService } from '@logger'
import { useAddKnowledgeItems } from '@renderer/hooks/useKnowledgeItems'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { getFileExtension } from '@renderer/utils/file'
import {
  type KnowledgeFileItemData,
  resolveFileEntryDataFromFile,
  resolveKnowledgeFileBatch,
  resolveKnowledgeFileMetadataEntryData,
  selectKnowledgeFileBatchOutcome
} from '@renderer/utils/knowledgeFileEntry'
import { isEvoStack } from '@renderer/utils/platform'
import type { KnowledgeAddItemConflict, KnowledgeAddItemInput, KnowledgeItemType } from '@shared/data/types/knowledge'
import { knowledgeSupportedFileExts } from '@shared/utils/file'

import { useKnowledgePage } from '../KnowledgePageProvider'
import AddKnowledgeItemDialogFooter from './addKnowledgeItemDialog/AddKnowledgeItemDialogFooter'
import AddKnowledgeItemDialogHeader from './addKnowledgeItemDialog/AddKnowledgeItemDialogHeader'
import AddKnowledgeItemDialogSourceTabs from './addKnowledgeItemDialog/AddKnowledgeItemDialogSourceTabs'
import { DEFAULT_SOURCE_TYPE } from './addKnowledgeItemDialog/constants'
import KnowledgeAddConflictDialog from './addKnowledgeItemDialog/KnowledgeAddConflictDialog'
import type { NoteDraft, NoteItem, NoteSourceMode } from './addKnowledgeItemDialog/types'

type ConflictResolution = 'rename' | 'replace'
const logger = loggerService.withContext('AddKnowledgeItemDialog')

interface PendingConflictState {
  items: KnowledgeAddItemInput[]
  conflicts: KnowledgeAddItemConflict[]
}

interface AddKnowledgeItemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

// `file` and `directory` skip the in-dialog panel entirely: clicking the menu item opens the OS
// picker directly and submits the selection. Only `note` / `url` still render the dialog panel.
const isDirectPickSource = (source: KnowledgeItemType) => source === 'file' || source === 'directory'

const nativeTextExtensions = ['.txt', '.md', '.csv', '.json', '.html']
const knowledgeSupportedFileExtSet = new Set<string>(knowledgeSupportedFileExts)
// Electron's open-dialog `filters` want bare extensions (no leading dot); the set above keeps the
// dots for the post-pick safety filter.
const knowledgeFilePickerExtensions = knowledgeSupportedFileExts.map((ext) => ext.replace(/^\./, ''))

const isSupportedKnowledgeFile = (fileName: string) =>
  isEvoStack
    ? nativeTextExtensions.includes(getFileExtension(fileName))
    : knowledgeSupportedFileExtSet.has(getFileExtension(fileName))

const describeFileMetadata = (file: { origin_name?: string; name?: string }) => file.origin_name || file.name

function pickNativeTextFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = nativeTextExtensions.join(',')
    input.multiple = true
    input.hidden = true
    const complete = (files: File[] | null) => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => complete(input.files ? Array.from(input.files) : null), { once: true })
    input.addEventListener('cancel', () => complete(null), { once: true })
    document.body.append(input)
    input.click()
  })
}

const AddKnowledgeItemDialog = ({ open, onOpenChange }: AddKnowledgeItemDialogProps) => {
  const { t } = useTranslation()
  const { selectedBaseId, pendingAddSource, pendingAddFiles, pendingAddDirectoryPaths } = useKnowledgePage()
  // The dialog mounts fresh per open (the section conditionally renders it), so the requested
  // source is fixed for this lifetime — derive it instead of mirroring it into state.
  const activeSource = pendingAddSource ?? DEFAULT_SOURCE_TYPE
  const directPick = isDirectPickSource(activeSource)

  const [noteMode, setNoteMode] = useState<NoteSourceMode>(isEvoStack ? 'create' : 'import')
  const [selectedNotes, setSelectedNotes] = useState<NoteItem[]>([])
  const [noteDraft, setNoteDraft] = useState<NoteDraft>({ title: '', content: '' })
  const [urlValue, setUrlValue] = useState('')
  const [submitErrorMessage, setSubmitErrorMessage] = useState('')
  const [isResolvingSubmit, setIsResolvingSubmit] = useState(false)
  const [pendingConflict, setPendingConflict] = useState<PendingConflictState | null>(null)
  const [pendingResolution, setPendingResolution] = useState<ConflictResolution | null>(null)
  const { submit: submitKnowledgeItems, isSubmitting: isSubmittingItems } = useAddKnowledgeItems(selectedBaseId)
  const invalidateCache = useInvalidateCache()

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const handleNoteToggle = useCallback((note: NoteItem) => {
    setSubmitErrorMessage('')
    setSelectedNotes((currentNotes) =>
      currentNotes.some((selected) => selected.externalPath === note.externalPath)
        ? currentNotes.filter((selected) => selected.externalPath !== note.externalPath)
        : [...currentNotes, note]
    )
  }, [])

  const handleNoteSelectionChange = useCallback((notes: NoteItem[]) => {
    setSubmitErrorMessage('')
    setSelectedNotes(notes)
  }, [])

  const handleNoteModeChange = useCallback((mode: NoteSourceMode) => {
    setSubmitErrorMessage('')
    setNoteMode(mode)
  }, [])

  // Title and content update independently so neither handler closes over the draft;
  // see the note on NoteCreateContent's props.
  const handleNoteDraftTitleChange = useCallback((title: string) => {
    setSubmitErrorMessage('')
    setNoteDraft((current) => ({ ...current, title }))
  }, [])

  const handleNoteDraftContentChange = useCallback((content: string) => {
    setSubmitErrorMessage('')
    setNoteDraft((current) => ({ ...current, content }))
  }, [])

  const canSubmit = useMemo(() => {
    if (!selectedBaseId) {
      return false
    }

    switch (activeSource) {
      case 'url':
        return urlValue.trim().length > 0
      case 'note':
        // A drafted note needs both halves: the title becomes the item's `source`
        // (schema-required, non-empty) and empty content indexes to nothing.
        return noteMode === 'create'
          ? noteDraft.title.trim().length > 0 && noteDraft.content.trim().length > 0
          : selectedNotes.length > 0
      default:
        return false
    }
  }, [activeSource, noteDraft.content, noteDraft.title, noteMode, selectedBaseId, selectedNotes.length, urlValue])

  const buildPanelSubmitItems = useCallback(async (): Promise<KnowledgeAddItemInput[]> => {
    if (activeSource === 'url') {
      const url = urlValue.trim()
      return [{ type: 'url' as const, data: { source: url, url } }]
    }

    if (activeSource === 'note') {
      if (noteMode === 'create') {
        return [{ type: 'note' as const, data: { source: noteDraft.title.trim(), content: noteDraft.content } }]
      }

      return Promise.all(
        selectedNotes.map(async (note) => {
          // Name the note in the failure so a read error (e.g. it was moved or
          // deleted while the dialog was open) points at the specific source.
          const content = await window.api.file.readExternal(note.externalPath).catch((cause) => {
            throw new Error(`${note.name}: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
          return { type: 'note' as const, data: { source: note.name, content } }
        })
      )
    }

    return []
  }, [activeSource, noteDraft.content, noteDraft.title, noteMode, selectedNotes, urlValue])

  // 'detect' (first pass) surfaces the conflict dialog when same-name collisions
  // exist; 'rename'/'replace' apply the user's choice. Closes the whole dialog
  // once the batch is actually added.
  const submitWithStrategy = useCallback(
    async (items: KnowledgeAddItemInput[], conflictStrategy: 'detect' | ConflictResolution) => {
      const result = await submitKnowledgeItems(items, conflictStrategy)
      if (result.status === 'conflicts') {
        setPendingConflict({ items, conflicts: result.conflicts })
        return
      }
      handleOpenChange(false)
    },
    [handleOpenChange, submitKnowledgeItems]
  )

  const handleSubmit = useCallback(() => {
    if (!canSubmit || isResolvingSubmit) {
      return
    }

    setSubmitErrorMessage('')
    setIsResolvingSubmit(true)

    void buildPanelSubmitItems()
      .then((items) => submitWithStrategy(items, 'detect'))
      .catch((error) => {
        setSubmitErrorMessage(formatErrorMessageWithPrefix(error, t('knowledge.data_source.add_dialog.submit.error')))
      })
      .finally(() => {
        setIsResolvingSubmit(false)
      })
  }, [buildPanelSubmitItems, canSubmit, isResolvingSubmit, submitWithStrategy, t])

  const collectResolvedFileInputs = useCallback(
    async <T,>(
      files: T[],
      resolveItem: (item: T) => Promise<KnowledgeFileItemData>,
      describeItem: (item: T) => string | undefined
    ): Promise<KnowledgeAddItemInput[]> => {
      const fileBatch = await resolveKnowledgeFileBatch(files, resolveItem, describeItem)
      const fileOutcome = selectKnowledgeFileBatchOutcome(fileBatch)
      if (fileOutcome.fatal !== undefined) {
        throw fileOutcome.fatal
      }
      if (fileOutcome.skipped.length > 0) {
        toast.warning(t('chat.save.knowledge.error.file_partial_failed', { count: fileOutcome.skipped.length }))
      }
      return fileOutcome.resolved.map((data) => ({ type: 'file' as const, data }))
    },
    [t]
  )

  // Collect file inputs from the OS picker (or page-level pending files, if any) and submit.
  // Returns null when the user cancels the picker so the caller can close the flow.
  const collectFileInputs = useCallback(async (): Promise<KnowledgeAddItemInput[] | null> => {
    if (pendingAddFiles?.length) {
      const supportedFiles = pendingAddFiles.filter((file) => isSupportedKnowledgeFile(file.name))
      const skippedCount = pendingAddFiles.length - supportedFiles.length
      if (skippedCount > 0) {
        toast.warning(t('knowledge.data_source.add_dialog.unsupported_files_skipped', { count: skippedCount }))
      }
      return collectResolvedFileInputs(supportedFiles, resolveFileEntryDataFromFile, (file) => file.name)
    }

    const selected = await window.api.file.select({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Knowledge', extensions: knowledgeFilePickerExtensions }]
    })

    if (!selected) {
      return null
    }

    const supportedFiles = selected.filter((file) => isSupportedKnowledgeFile(file.origin_name || file.name))
    const skippedCount = selected.length - supportedFiles.length
    if (skippedCount > 0) {
      toast.warning(t('knowledge.data_source.add_dialog.unsupported_files_skipped', { count: skippedCount }))
    }
    return collectResolvedFileInputs(supportedFiles, resolveKnowledgeFileMetadataEntryData, describeFileMetadata)
  }, [collectResolvedFileInputs, pendingAddFiles, t])

  const collectDirectoryInputs = useCallback(async (): Promise<KnowledgeAddItemInput[] | null> => {
    const directoryPath = await window.api.file.selectFolder()

    if (!directoryPath) {
      return null
    }

    return [{ type: 'directory' as const, data: { source: directoryPath } }]
  }, [])

  // For file/directory sources the menu click should feel like "open the OS picker": fire it once
  // on mount, then submit. A ref guards against the effect running twice (StrictMode / re-renders).
  const directPickStartedRef = useRef(false)
  useEffect(() => {
    if (!open || !directPick || directPickStartedRef.current) {
      return
    }
    directPickStartedRef.current = true

    const run = async () => {
      setIsResolvingSubmit(true)
      let nativeImportStarted = false
      try {
        if (isEvoStack && (activeSource === 'file' || activeSource === 'directory')) {
          if (activeSource === 'directory' || pendingAddDirectoryPaths?.length) {
            throw new Error(t('knowledge.evostack.text_sources_only'))
          }
          const files = pendingAddFiles?.length ? pendingAddFiles : await pickNativeTextFiles()
          if (files?.length) {
            if (!selectedBaseId) throw new Error(t('knowledge.name_required'))
            for (const file of files) {
              if (!isSupportedKnowledgeFile(file.name) || file.size > 1_000_000) {
                throw new Error(`${file.name}: ${t('knowledge.evostack.text_sources_only')}`)
              }
            }
            for (const file of files) {
              const content = await file.text()
              nativeImportStarted = true
              await ipcApi.request('knowledge.import_text', {
                baseId: selectedBaseId,
                name: file.name,
                content
              })
            }
          }
          handleOpenChange(false)
          return
        }
        let items: KnowledgeAddItemInput[] | null
        if (pendingAddDirectoryPaths?.length) {
          const fileInputs = pendingAddFiles?.length ? await collectFileInputs() : []
          items = [
            ...(fileInputs ?? []),
            ...pendingAddDirectoryPaths.map((source) => ({ type: 'directory' as const, data: { source } }))
          ]
        } else {
          items = activeSource === 'file' ? await collectFileInputs() : await collectDirectoryInputs()
        }
        // Picker cancelled or nothing selectable — close the (panel-less) flow.
        if (!items || items.length === 0) {
          handleOpenChange(false)
          return
        }
        await submitWithStrategy(items, 'detect')
      } catch (error) {
        toast.error(formatErrorMessageWithPrefix(error, t('knowledge.data_source.add_dialog.submit.error')))
        handleOpenChange(false)
      } finally {
        if (nativeImportStarted && selectedBaseId) {
          try {
            await invalidateCache([`/knowledge-bases/${selectedBaseId}/items`, '/knowledge-bases'])
          } catch (error) {
            logger.error(
              'Failed to refresh knowledge source list after text import',
              error instanceof Error ? error : new Error(String(error)),
              { baseId: selectedBaseId }
            )
          }
        }
        setIsResolvingSubmit(false)
      }
    }

    void run()
  }, [
    activeSource,
    collectDirectoryInputs,
    collectFileInputs,
    directPick,
    handleOpenChange,
    invalidateCache,
    open,
    pendingAddDirectoryPaths,
    pendingAddFiles,
    selectedBaseId,
    submitWithStrategy,
    t
  ])

  const handleConflictResolve = useCallback(
    (resolution: ConflictResolution) => {
      if (!pendingConflict) {
        return
      }

      setPendingResolution(resolution)
      void submitWithStrategy(pendingConflict.items, resolution)
        .catch((error) => {
          setPendingConflict(null)
          const message = formatErrorMessageWithPrefix(error, t('knowledge.data_source.add_dialog.submit.error'))
          // Direct-pick sources have no panel to fall back to, so report inline (toast) and close.
          if (directPick) {
            toast.error(message)
            handleOpenChange(false)
          } else {
            setSubmitErrorMessage(message)
          }
        })
        .finally(() => {
          setPendingResolution(null)
        })
    },
    [directPick, handleOpenChange, pendingConflict, submitWithStrategy, t]
  )

  const handleConflictCancel = useCallback(() => {
    setPendingConflict(null)
    // No panel exists behind a direct-pick conflict, so cancelling ends the whole flow.
    if (directPick) {
      handleOpenChange(false)
    }
  }, [directPick, handleOpenChange])

  const isSubmitting = isResolvingSubmit || isSubmittingItems

  return (
    <>
      {directPick ? null : (
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogContent
            closeOnOverlayClick={false}
            size={activeSource === 'url' ? 'sm' : 'lg'}
            className="flex max-h-[70vh] flex-col overflow-hidden">
            <AddKnowledgeItemDialogHeader title={t('knowledge.data_source.add_dialog.title')} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pr-1">
              <AddKnowledgeItemDialogSourceTabs
                activeSource={activeSource}
                noteMode={noteMode}
                selectedNotes={selectedNotes}
                noteDraft={noteDraft}
                urlValue={urlValue}
                onNoteModeChange={handleNoteModeChange}
                onNoteToggle={handleNoteToggle}
                onNoteSelectionChange={handleNoteSelectionChange}
                onNoteDraftTitleChange={handleNoteDraftTitleChange}
                onNoteDraftContentChange={handleNoteDraftContentChange}
                onUrlValueChange={(value) => {
                  setSubmitErrorMessage('')
                  setUrlValue(value)
                }}
              />
            </div>
            <AddKnowledgeItemDialogFooter
              activeSource={activeSource}
              canSubmit={canSubmit}
              errorMessage={submitErrorMessage}
              isSubmitting={isSubmitting}
              // A draft submits exactly one note, and picks made before switching modes
              // are not part of it — report nothing so the footer stays quiet.
              selectedNoteCount={noteMode === 'create' ? 0 : selectedNotes.length}
              onSubmit={handleSubmit}
            />
          </DialogContent>
        </Dialog>
      )}
      <KnowledgeAddConflictDialog
        open={pendingConflict !== null}
        conflicts={pendingConflict?.conflicts ?? []}
        pendingResolution={pendingResolution}
        onResolve={handleConflictResolve}
        onCancel={handleConflictCancel}
      />
    </>
  )
}

export default AddKnowledgeItemDialog

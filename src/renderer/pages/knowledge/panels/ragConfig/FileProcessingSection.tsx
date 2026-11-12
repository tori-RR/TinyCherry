import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { isEvoStack } from '@renderer/utils/platform'

import { FileProcessorSelector, type FileProcessorSelectorOption } from './FileProcessorSelector'
import { RagFieldLabel } from './panelPrimitives'

interface FileProcessingSectionProps {
  fileProcessorId: string | null
  initialFileProcessorId: string | null
  fileProcessorOptions: FileProcessorSelectorOption[]
  onFileProcessorChange: (value: string | null) => void
}

const FileProcessingSection = ({
  fileProcessorId,
  fileProcessorOptions,
  onFileProcessorChange
}: FileProcessingSectionProps) => {
  const { t } = useTranslation()
  return (
    <div>
      <RagFieldLabel label={t('knowledge.rag.file_processing')} hint={t('knowledge.rag.file_processing_hint')} />
      {isEvoStack ? (
        <div className="flex flex-col gap-1.5">
          <Button type="button" variant="outline" disabled className="h-8 w-full justify-start font-normal">
            {t('knowledge.rag.file_processing_none')}
          </Button>
          <p className="m-0 text-muted-foreground text-xs">{t('knowledge.evostack.text_sources_only')}</p>
        </div>
      ) : (
        <FileProcessorSelector
          aria-label={t('knowledge.rag.file_processing')}
          value={fileProcessorId}
          options={fileProcessorOptions}
          placeholder={t('knowledge.rag.file_processing_none')}
          settingsLabel={t('common.go_to_settings')}
          onChange={onFileProcessorChange}
          onSettingsNavigate={() => openSettingsTab('/settings/file-processing')}
        />
      )}
    </div>
  )
}

export default FileProcessingSection

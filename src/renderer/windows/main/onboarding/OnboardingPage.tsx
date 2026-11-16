import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { ArrowLeft, Check, KeyRound, Languages } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip
} from '@cherrystudio/ui'
import { dataApiService } from '@data/DataApiService'
import { usePreference } from '@data/hooks/usePreference'
import AppLogo from '@renderer/assets/images/logo.png'
import { WindowControls } from '@renderer/components/WindowControls'
import { useDefaultModel, useModels } from '@renderer/hooks/useModel'
import { useProviders } from '@renderer/hooks/useProvider'
import { appLanguageOptions, isAppLanguage } from '@renderer/i18n/languages'
import i18n from '@renderer/i18n/resolver'
import ModelSettings from '@renderer/pages/settings/ModelSettings/ModelSettings'
import { ProviderSettingsPage } from '@renderer/pages/settings/ProviderSettings'
import { toast } from '@renderer/services/toast'
import { isWin } from '@renderer/utils/platform'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID, isManagedCherryProviderId } from '@shared/data/presets/cherryai'
import type { Model } from '@shared/data/types/model'
import { APP_NAME } from '@shared/utils/constants'
import { defaultLanguage } from '@shared/utils/languages'
import { isNonChatModel } from '@shared/utils/model'

type OnboardingStep = 'welcome' | 'provider' | 'select-model'
const isOnboardingModel = (model: Model) => !isManagedCherryProviderId(model.providerId) && !isNonChatModel(model)
function OnboardingProviderSettings() {
  const router = useMemo(
    () =>
      createRouter({
        routeTree: createRootRoute({ component: () => <ProviderSettingsPage /> }),
        history: createMemoryHistory({ initialEntries: ['/'] })
      }),
    []
  )
  return <RouterProvider router={router} />
}
export default function OnboardingPage() {
  const { t } = useTranslation()
  const [language, setLanguage] = usePreference('app.language')
  const [, setProviderSetupStatus] = usePreference('app.onboarding.provider_setup.status')
  const { providers: enabledProviders, isLoading: isProvidersLoading } = useProviders({ enabled: true })
  const { models: enabledModels, isLoading: isModelsLoading } = useModels({ enabled: true })
  const { defaultModel, quickModel, translateModel } = useDefaultModel()
  const [step, setStep] = useState<OnboardingStep>('welcome')
  const [isCompleting, setIsCompleting] = useState(false)
  const eligibleProviderIds = new Set(
    enabledProviders.filter((provider) => !isManagedCherryProviderId(provider.id)).map((provider) => provider.id)
  )
  const canCompleteModelSetup = [defaultModel, quickModel, translateModel].every(
    (model) => model && eligibleProviderIds.has(model.providerId) && isOnboardingModel(model)
  )
  const hasEligibleProvider = eligibleProviderIds.size > 0
  const hasEligibleModel = enabledModels.some(
    (model) => eligibleProviderIds.has(model.providerId) && isOnboardingModel(model)
  )
  const isProviderSetupLoading = isProvidersLoading || isModelsLoading
  const canContinueProviderSetup = !isProviderSetupLoading && hasEligibleProvider && hasEligibleModel
  const providerSetupHint = !isProviderSetupLoading
    ? !hasEligibleProvider
      ? t('onboarding.provider_setup.missing_provider')
      : !hasEligibleModel
        ? t('onboarding.provider_setup.missing_model')
        : null
    : null
  const resolvedLanguage = i18n.resolvedLanguage ?? i18n.language
  const displayLanguage = isAppLanguage(language)
    ? language
    : isAppLanguage(resolvedLanguage)
      ? resolvedLanguage
      : defaultLanguage
  const displayLanguageLabel = appLanguageOptions.find((option) => option.value === displayLanguage)?.label
  const handleLanguageChange = (value: string) => {
    if (isAppLanguage(value)) {
      void i18n.changeLanguage(value)
      void setLanguage(value)
    }
  }
  const updateSeededResourceModels = useCallback(async (model: Model) => {
    const { items, total } = await dataApiService.get('/assistants', { query: { limit: 2 } })
    const assistant = total === 1 ? items[0] : undefined
    if (assistant?.modelId === CHERRYAI_DEFAULT_UNIQUE_MODEL_ID)
      await dataApiService.patch(`/assistants/${assistant.id}`, { body: { modelId: model.id } })
  }, [])
  const complete = useCallback(
    async (status: 'completed' | 'skipped') => {
      setIsCompleting(true)
      try {
        if (status === 'completed' && defaultModel) await updateSeededResourceModels(defaultModel)
        await setProviderSetupStatus(status)
      } catch {
        toast.error(t('onboarding.toast.complete_failed'))
      } finally {
        setIsCompleting(false)
      }
    },
    [defaultModel, setProviderSetupStatus, t, updateSeededResourceModels]
  )
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-sidebar text-foreground">
      <div
        className="drag flex h-[var(--app-top-chrome-height)] shrink-0 items-stretch justify-end"
        style={isWin ? { minHeight: 'env(titlebar-area-height, 0px)' } : undefined}>
        <div className="nodrag mr-2 flex items-center gap-1">
          <div data-onboarding-language-select="" className="nodrag">
            <Select value={displayLanguage} onValueChange={handleLanguageChange}>
              <SelectTrigger
                aria-label={t('common.language')}
                size="sm"
                className="nodrag h-7 w-auto gap-1.5 border-0 bg-transparent px-2 text-muted-foreground text-xs shadow-none hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent/50 focus-visible:text-foreground aria-expanded:border-transparent aria-expanded:ring-0 dark:bg-transparent [&_svg]:size-3.5 [&_svg]:opacity-60">
                <Languages className="size-3.5" />
                <SelectValue>{displayLanguageLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {appLanguageOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span aria-hidden="true">{option.flag}</span>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {step !== 'welcome' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="nodrag text-muted-foreground hover:text-foreground"
              onClick={() => void complete('skipped')}
              disabled={isCompleting}>
              {t('onboarding.skip')}
            </Button>
          )}
        </div>
        <WindowControls />
      </div>

      <div className="flex min-h-0 flex-1 px-2 pb-2">
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border-[0.5px] border-border bg-background">
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {step === 'welcome' && (
              <div className="flex h-full w-full items-center justify-center px-6 pb-20">
                <div className="flex w-full max-w-[420px] flex-col items-center">
                  <img src={AppLogo} alt={APP_NAME} className="size-16 rounded-xl" />
                  <div className="mt-5 flex flex-col gap-2 text-center">
                    <h1 className="m-0 font-semibold text-2xl text-foreground">
                      {t('onboarding.welcome.title', { appName: APP_NAME })}
                    </h1>
                    <p className="m-0 text-muted-foreground text-sm">{t('onboarding.welcome.subtitle')}</p>
                  </div>
                  <div className="mt-8 flex w-full flex-col gap-3">
                    <Button
                      type="button"
                      variant="default"
                      size="lg"
                      className="h-11 w-full rounded-xl"
                      disabled={isCompleting}
                      onClick={() => setStep('provider')}>
                      <KeyRound size={16} />
                      {t('onboarding.welcome.configure_provider')}
                    </Button>
                    {
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        className="h-11 w-full rounded-xl"
                        loading={isCompleting}
                        disabled={isCompleting}
                        onClick={() => void complete('skipped')}>
                        {t('onboarding.skip')}
                      </Button>
                    }
                  </div>
                  <p className="mt-4 mb-0 text-center text-muted-foreground text-xs">
                    {t('onboarding.welcome.setup_hint')}
                  </p>
                </div>
              </div>
            )}

            {step === 'provider' && (
              <div className="flex h-full min-h-0 w-full flex-col">
                <OnboardingHeader
                  title={t('onboarding.provider_setup.title')}
                  onBack={() => setStep('welcome')}
                  padded
                />
                <div className="min-h-0 flex-1 border-border border-y">
                  <OnboardingProviderSettings />
                </div>
                <div className="flex shrink-0 justify-end gap-2 px-5 py-3">
                  <Button type="button" variant="outline" onClick={() => setStep('welcome')}>
                    {t('common.back')}
                  </Button>
                  <Tooltip
                    content={providerSetupHint}
                    placement="top"
                    classNames={{
                      content:
                        'dark:bg-neutral-100 dark:text-neutral-900 dark:[&_svg]:fill-neutral-100! dark:[&_svg]:stroke-neutral-100!'
                    }}>
                    <Button
                      type="button"
                      aria-disabled={!canContinueProviderSetup}
                      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                      onClick={() => canContinueProviderSetup && setStep('select-model')}>
                      {t('onboarding.provider_setup.next')}
                    </Button>
                  </Tooltip>
                </div>
              </div>
            )}

            {step === 'select-model' && (
              <div className="flex h-full min-h-0 w-full flex-col">
                <OnboardingHeader
                  title={t('onboarding.select_model.title')}
                  onBack={() => setStep('provider')}
                  padded
                />
                <ScrollArea
                  contentProps={{ className: 'flex justify-center px-6 py-8' }}
                  className="min-h-0 flex-1 border-border border-t">
                  <div className="my-auto w-full max-w-[440px]">
                    <div className="w-full">
                      <ModelSettings
                        autoFillEmptyModels
                        onDefaultModelSelected={updateSeededResourceModels}
                        showSettingsButton={false}
                        showDescription={false}
                        showDividers={false}
                        showPaintingModel={false}
                        modelFilter={isOnboardingModel}
                        compact
                        className="mt-4 min-h-0 w-full flex-none overflow-visible"
                      />
                      <div className="mt-5 flex flex-col items-center gap-3">
                        <Button
                          type="button"
                          size="lg"
                          className="w-full"
                          loading={isCompleting}
                          disabled={!canCompleteModelSetup}
                          onClick={() => void complete('completed')}>
                          <Check size={16} />
                          {t('onboarding.select_model.start')}
                        </Button>
                        <p className="m-0 text-center text-muted-foreground text-xs">
                          {t('onboarding.select_model.change_later')}
                        </p>
                      </div>
                    </div>
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
interface OnboardingHeaderProps {
  title: string
  onBack: () => void
  padded?: boolean
}
function OnboardingHeader({ title, onBack, padded = false }: OnboardingHeaderProps) {
  return (
    <div className={padded ? 'flex shrink-0 items-center gap-3 px-5 py-4' : 'flex shrink-0 items-center gap-3 py-4'}>
      <Button type="button" variant="outline" size="icon-sm" className="shrink-0" onClick={onBack} aria-label={title}>
        <ArrowLeft size={15} />
      </Button>
      <div className="flex min-w-0 flex-1 items-center">
        <h2 className="m-0 truncate font-semibold text-base text-foreground">{title}</h2>
      </div>
    </div>
  )
}

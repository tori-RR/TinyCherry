import { Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Avatar, AvatarImage, Button, ColFlex, EmojiAvatar } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import AppLogo from '@renderer/assets/images/logo.png'
import { CommandShortcut } from '@renderer/components/command'
import useAvatar from '@renderer/hooks/useAvatar'
import { ipcApi } from '@renderer/ipc'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { isEmoji } from '@renderer/utils/naming'
import { isEvoStack } from '@renderer/utils/platform'
import { APP_NAME } from '@shared/utils/constants'

import { AppearanceMenu } from './layout/AppearanceMenu'
import { NotificationCenterButton } from './NotificationCenter'

export function UserAccountPanel({
  onRequestClose,
  onNotificationsOpen,
  children
}: {
  onRequestClose?: () => void
  onNotificationsOpen?: () => void
  children?: ReactNode
}) {
  const [userName] = usePreference('app.user.name')
  const { t } = useTranslation()
  const avatar = useAvatar()
  const { data: appInfo } = useSWR(isEvoStack ? 'app.get_info' : null, () => ipcApi.request('app.get_info'), {
    shouldRetryOnError: false
  })
  const accountDisplayName = isEvoStack ? APP_NAME : userName || t('chat.user')

  const handleOpenSettings = () => {
    onRequestClose?.()
    openSettingsTab()
  }

  return (
    <ColFlex className="w-56 p-1.5">
      <ColFlex className="pb-1">
        <div className="flex min-h-9 items-center gap-2 px-2 py-1">
          <span className="flex w-4 shrink-0 items-center justify-center">
            {isEvoStack ? (
              <img src={AppLogo} alt="" className="size-5 shrink-0 object-contain" />
            ) : isEmoji(avatar) ? (
              <EmojiAvatar size={20} fontSize={12} className="shrink-0">
                {avatar}
              </EmojiAvatar>
            ) : (
              <Avatar className="size-5 shrink-0 rounded-full">
                <AvatarImage src={avatar} className="object-cover" />
              </Avatar>
            )}
          </span>
          <ColFlex className="min-w-0 flex-1 gap-0">
            <span className="truncate font-medium text-[13px] text-foreground leading-[18px]">
              {accountDisplayName}
            </span>
            {isEvoStack && appInfo ? (
              <span className="text-muted-foreground text-xs leading-4">v{appInfo.version}</span>
            ) : null}
          </ColFlex>
        </div>
      </ColFlex>
      <ColFlex className="border-border-subtle gap-0.5 border-t py-1">
        <NotificationCenterButton
          onRequestClose={() => {
            onNotificationsOpen?.()
            onRequestClose?.()
          }}
        />
        <AppearanceMenu onRequestClose={onRequestClose} />
        {children}
      </ColFlex>
      <ColFlex className="border-border-subtle border-t pt-1">
        <Button
          className="h-8 min-h-8 w-full justify-start gap-2 rounded-md bg-transparent px-2 py-0 text-[13px] text-foreground leading-5"
          onClick={handleOpenSettings}
          size="sm"
          variant="ghost">
          <Settings className="!text-muted-foreground size-4" aria-hidden />
          <span className="min-w-0 flex-1 text-left">{t('common.settings')}</span>
          <CommandShortcut
            command="app.settings.open"
            className="ml-auto h-auto min-w-0 rounded-none bg-transparent p-0 text-[13px] shadow-none"
          />
        </Button>
      </ColFlex>
    </ColFlex>
  )
}

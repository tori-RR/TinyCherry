import { arrayMove } from '@dnd-kit/sortable'
import { isDesktopRouteAvailable } from '@platform/desktop-api/capabilities'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { ScrollArea } from '@cherrystudio/ui'
import { Sortable } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import agentsIcon from '@renderer/assets/images/apps/launchpad-agents.svg'
import assistantsIcon from '@renderer/assets/images/apps/launchpad-assistants.svg'
import codeToolsIcon from '@renderer/assets/images/apps/launchpad-code-tools.svg'
import filesIcon from '@renderer/assets/images/apps/launchpad-files.svg'
import knowledgeIcon from '@renderer/assets/images/apps/launchpad-knowledge.svg'
import marketplaceIcon from '@renderer/assets/images/apps/launchpad-marketplace.svg'
import miniAppIcon from '@renderer/assets/images/apps/launchpad-mini-app.svg'
import notesIcon from '@renderer/assets/images/apps/launchpad-notes.svg'
import paintingsIcon from '@renderer/assets/images/apps/launchpad-paintings.svg'
import scheduledTasksIcon from '@renderer/assets/images/apps/launchpad-scheduled-tasks.svg'
import { SidebarIcon } from '@renderer/components/app/sidebarIcons'
import { CommandContextMenu, type CommandContextMenuExtraItem } from '@renderer/components/command'
import SidebarShortcutIcon from '@renderer/components/icons/SidebarShortcutIcon'
import { useLaunchpadAppOrder } from '@renderer/hooks/useLaunchpadAppOrder'
import { useSidebarShortcuts } from '@renderer/hooks/useSidebarShortcuts'
import { getSidebarIconLabelKey } from '@renderer/i18n/label'
import { parseAppRouteUrl } from '@renderer/utils/appRouteUrl'
import type { SidebarAppId } from '@renderer/utils/sidebar'
import { createSidebarShortcutTarget, getSidebarMenuPath, SIDEBAR_SHORTCUT_PROVIDER_IDS } from '@renderer/utils/sidebar'
const LAUNCHPAD_GRID_CLASS = 'grid grid-cols-6 justify-items-center gap-2 px-2'
const LAUNCHPAD_ITEM_CLASS = 'mx-auto w-[92px]'
const APP_ICON_SURFACE_CLASS =
  'relative flex size-14 items-center justify-center overflow-hidden rounded-2xl border border-border-subtle bg-transparent transition-[background-color] duration-[160ms] ease-in-out group-hover:bg-accent group-focus-visible:bg-accent motion-reduce:transition-none'
const APP_ICON_FRAME_CLASS =
  'relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl select-none'
const APP_ICON_CLASS = 'size-11 object-contain'
const SORTABLE_CONTENTS_STYLE = { display: 'contents' } as const
const APP_ICON_SOURCES: Record<SidebarAppId, string | undefined> = {
  assistants: assistantsIcon,
  agents: agentsIcon,
  knowledge: knowledgeIcon,
  scheduled_tasks: scheduledTasksIcon,
  paintings: paintingsIcon,
  marketplace: marketplaceIcon,
  mini_app: miniAppIcon,
  files: filesIcon,
  code_tools: codeToolsIcon,
  notes: notesIcon
}
export default function LaunchpadPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [defaultPaintingProvider] = usePreference('feature.paintings.default_provider')
  const { isPinned, setPinned } = useSidebarShortcuts()
  const { orderedAppIds, reorderApps } = useLaunchpadAppOrder()
  const suppressClickUntilRef = useRef(0)
  const draggedItemIdRef = useRef<string | null>(null)
  const handleSortableDragStart = useCallback((event: { activeId: string | number }) => {
    draggedItemIdRef.current = String(event.activeId)
    suppressClickUntilRef.current = Date.now() + 500
  }, [])
  // The pointer sensor fires a synthetic click on the dragged element after drop;
  // refresh the window on settle so the click is still suppressed after long drags.
  const handleSortableDragSettled = useCallback(() => {
    suppressClickUntilRef.current = Date.now() + 500
  }, [])
  // Only swallow the post-drag click on the item that was actually dragged.
  const shouldSuppressLaunchClick = useCallback(
    (id: string) => id === draggedItemIdRef.current && Date.now() < suppressClickUntilRef.current,
    []
  )
  const navigateToUrl = useCallback(
    (url: string) => {
      const parsedUrl = parseAppRouteUrl(url)
      if (!parsedUrl) return
      if (parsedUrl.search) {
        return navigate({
          to: parsedUrl.pathname,
          search: Object.fromEntries(parsedUrl.searchParams.entries())
        })
      }
      return navigate({ to: parsedUrl.pathname })
    },
    [navigate]
  )
  const openLaunchpadItem = (favorite: SidebarAppId) => {
    if (shouldSuppressLaunchClick(favorite)) return
    // Launchpad opens each app at its base entry (chat -> new conversation,
    // agents -> new session). Resuming the last-used instance is the sidebar's
    // job, not the launcher's.
    const path = getSidebarMenuPath(favorite, defaultPaintingProvider)
    if (!path) return
    void navigateToUrl(path)
  }
  const pinToSidebar = useCallback(
    (favorite: SidebarAppId) => {
      const target = createSidebarShortcutTarget(SIDEBAR_SHORTCUT_PROVIDER_IDS.APP, favorite)
      setPinned(target, true, t(getSidebarIconLabelKey(favorite)))
    },
    [setPinned, t]
  )
  const unpinFromSidebar = useCallback(
    (favorite: SidebarAppId) => {
      const target = createSidebarShortcutTarget(SIDEBAR_SHORTCUT_PROVIDER_IDS.APP, favorite)
      setPinned(target, false)
    },
    [setPinned]
  )
  const getAppContextMenuItems = useCallback(
    (favorite: SidebarAppId): CommandContextMenuExtraItem[] => {
      const target = createSidebarShortcutTarget(SIDEBAR_SHORTCUT_PROVIDER_IDS.APP, favorite)
      const pinned = isPinned(target)
      return [
        {
          type: 'item',
          id: `launchpad.${pinned ? 'unpin-from-sidebar' : 'pin-to-sidebar'}.${favorite}`,
          label: t(pinned ? 'launchpad.unpin_from_sidebar' : 'launchpad.pin_to_sidebar'),
          icon: <SidebarShortcutIcon size={14} pinned={pinned} />,
          onSelect: () => (pinned ? unpinFromSidebar(favorite) : pinToSidebar(favorite))
        }
      ]
    },
    [isPinned, pinToSidebar, t, unpinFromSidebar]
  )
  const appMenuItems = useMemo(
    () =>
      orderedAppIds.flatMap((favorite) => {
        if (!isDesktopRouteAvailable(getSidebarMenuPath(favorite, defaultPaintingProvider))) return []
        return [
          {
            id: favorite,
            iconSrc: APP_ICON_SOURCES[favorite],
            text: t(getSidebarIconLabelKey(favorite)),
            menuItems: getAppContextMenuItems(favorite)
          }
        ]
      }),
    [defaultPaintingProvider, getAppContextMenuItems, orderedAppIds, t]
  )
  const handleAppsSortEnd = useCallback(
    ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      const nextItems = arrayMove(appMenuItems, oldIndex, newIndex)
      reorderApps(nextItems.map((item) => item.id))
    },
    [appMenuItems, reorderApps]
  )
  const renderAppMenuItem = (item: (typeof appMenuItems)[number]) => (
    <CommandContextMenu key={item.id} location="webcontents.context" extraItems={item.menuItems}>
      <button
        type="button"
        data-dnd-row-control
        onClick={() => openLaunchpadItem(item.id)}
        className={`${LAUNCHPAD_ITEM_CLASS} group flex cursor-pointer flex-col items-center gap-1 rounded-2xl px-1 py-2 text-center outline-none transition-transform duration-200 hover:scale-105 focus-visible:scale-105 active:scale-95`}>
        <span className="relative flex size-14 items-center justify-center">
          <span className={APP_ICON_SURFACE_CLASS}>
            <span className={APP_ICON_FRAME_CLASS}>
              {item.iconSrc ? (
                <img src={item.iconSrc} alt="" className={APP_ICON_CLASS} draggable={false} />
              ) : (
                <SidebarIcon icon={item.id} className="size-9 text-foreground" />
              )}
            </span>
          </span>
        </span>
        <span className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-foreground">
          {item.text}
        </span>
      </button>
    </CommandContextMenu>
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-180 flex-col gap-5 py-12.5">
          <section className="flex flex-col gap-2">
            <h2 className="m-0 px-9 py-0 font-semibold text-[14px] text-foreground opacity-80">
              {t('launchpad.apps')}
            </h2>
            <div className={LAUNCHPAD_GRID_CLASS}>
              <Sortable
                items={appMenuItems}
                itemKey="id"
                layout="grid"
                listStyle={SORTABLE_CONTENTS_STYLE}
                onDragStart={handleSortableDragStart}
                onDragEnd={handleSortableDragSettled}
                onDragCancel={handleSortableDragSettled}
                onSortEnd={handleAppsSortEnd}
                renderItem={(item) => renderAppMenuItem(item)}
              />
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

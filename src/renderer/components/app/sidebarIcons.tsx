import type { LucideProps } from 'lucide-react'
import {
  BotMessageSquare,
  BookOpen,
  Code,
  FileText,
  Folder,
  Icon,
  LayoutGrid,
  MessageSquare,
  MessagesSquare,
  MousePointerClick,
  NotepadText,
  Package,
  Palette
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { SidebarAppId } from '@renderer/utils/sidebar'

type SidebarIconComponent = (props: LucideProps) => ReactNode

const CodeMateIcon: SidebarIconComponent = (props) => <Code {...props} viewBox="-2 -2 28 28" />

/**
 * Icon component for each built-in sidebar app. Keyed by the `SidebarAppId` union so the
 * compiler enforces full coverage — adding a new sidebar app id without an icon
 * here is a type error. Kept in the component layer because the values are React
 * components; the navigation data and logic live in `@renderer/utils/sidebar`.
 */
export const SIDEBAR_ICON_COMPONENTS = {
  assistants: MessageSquare,
  agents: MousePointerClick,
  paintings: Palette,
  knowledge: BookOpen,
  mini_app: LayoutGrid,
  files: Folder,
  code_tools: CodeMateIcon,
  notes: NotepadText
} satisfies Record<SidebarAppId, SidebarIconComponent>

const RESOURCE_ICON_COMPONENTS = {
  topic: MessagesSquare,
  knowledgeBase: BookOpen,
  agentSession: BotMessageSquare,
  fileEntry: FileText,
  miniApp: Package
}

const NAVIGATION_ICON_COMPONENTS = { ...SIDEBAR_ICON_COMPONENTS, ...RESOURCE_ICON_COMPONENTS }
type SidebarGlyph = keyof typeof NAVIGATION_ICON_COMPONENTS

// Interior details are transparent cutouts so filled glyphs work on translucent sidebars too.
const FILLED_PATHS: Partial<Record<SidebarGlyph, string>> = {
  code_tools: 'M7.1 5.1 8.9 6.9 3.8 12l5.1 5.1-1.8 1.8L.2 12Z M16.9 5.1 23.8 12l-6.9 6.9-1.8-1.8 5.1-5.1-5.1-5.1Z',
  paintings:
    'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8Z M12 6.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0 M16 10.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0 M5 12.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0 M7 7.5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0',
  notes:
    'M6 4h1V2h2v2h2V2h2v2h2V2h2v2h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z M8 9v2h6V9Z M8 13v2h8v-2Z M8 17v2h5v-2Z',
  topic:
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z M16 9h4a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-3h2a4 4 0 0 0 4-4Z',
  agentSession:
    'M8 1h5v5h5a2 2 0 0 1 2 2v3h2v2h-2v3a2 2 0 0 1-2 2H8l-4 4v-9H2v-2h2V8a2 2 0 0 1 2-2h5V3H8Z M8 10v4h2v-4Z M14 10v4h2v-4Z',
  fileEntry:
    'M6 2h7v5a2 2 0 0 0 2 2h5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z M15 2l5 5h-5Z M8 8v2h3V8Z M8 12v2h8v-2Z M8 16v2h8v-2Z',
  miniApp:
    'M8.3 3.813 11 2.27a2 2 0 0 1 2 0l7 4a2 2 0 0 1 .38.28L16.5 8.78Z M6.7 4.727 4 6.27a2 2 0 0 0-.38.28L12 11.36l2.9-1.665Z M3 8.03l8.2 4.706v9.095a2 2 0 0 1-.2-.101l-7-4A2 2 0 0 1 3 16Z M21 8.03l-8.2 4.706v9.095a2 2 0 0 0 .2-.101l7-4A2 2 0 0 0 21 16Z'
}

export function SidebarIcon({
  icon,
  active = false,
  ...props
}: LucideProps & { icon: SidebarGlyph; active?: boolean }) {
  const Outline = NAVIGATION_ICON_COMPONENTS[icon]
  if (!active) return <Outline {...props} />
  const filledPath = FILLED_PATHS[icon]
  if (filledPath) {
    return (
      <Icon
        {...props}
        viewBox={icon === 'code_tools' ? '-2 -2 28 28' : '-1 -1 26 26'}
        iconNode={[['path', { d: filledPath, key: 'fill' }]]}
        fill="currentColor"
        fillRule="evenodd"
        stroke="none"
      />
    )
  }
  return <Outline {...props} viewBox="-1 -1 26 26" fill="currentColor" />
}

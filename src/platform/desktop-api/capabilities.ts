import { z } from 'zod'

export const capabilityNames = [
  'chat',
  'knowledge',
  'prompts',
  'skills',
  'computerUse',
  'markdownPreview',
  'notifications',
  'archives',
  'agents',
  'mcp',
  'attachments',
  'backups',
  'browser',
  'painting',
  'translation',
  'downloads',
  'globalShortcuts',
  'extraWindows',
  'skillExecution'
] as const
export const desktopInfoSchema = z
  .object({
    platform: z.enum(['win32', 'darwin', 'linux']),
    arch: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
    protocol: z.literal(1),
    capabilities: z.record(z.enum(capabilityNames), z.boolean())
  })
  .strict()

/** Presentation support only; OS permission and application grants stay in Rust/Go. */
export function hasCapability(name: (typeof capabilityNames)[number]): boolean {
  return window.desktop?.info.capabilities[name] === true
}

export function isDesktopRouteAvailable(raw: string): boolean {
  const path = raw.split(/[?#]/, 1)[0]
  if (path === '/app/agents' || path.startsWith('/app/agents/')) return hasCapability('agents')
  if (path === '/app/paintings' || path.startsWith('/app/paintings/')) return hasCapability('painting')
  return [
    '/app/chat',
    '/app/launchpad',
    '/app/knowledge',
    '/app/file-preview',
    '/app/release-notes',
    '/settings/provider',
    '/settings/model',
    '/settings/general',
    '/settings/appearance',
    '/settings/prompts',
    '/settings/skills',
    '/settings/computer-use',
    '/settings/archive',
    '/settings/notifications',
    '/settings/usage',
    '/settings/about',
    '/settings/search'
  ].some((route) => path === route || path.startsWith(`${route}/`))
}

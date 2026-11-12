import type { SystemProviderId } from '@shared/utils/systemProviderId'

// Registry definitions remain available to providers configured before these presets were removed.
const excludedProviderPresetIds: ReadonlySet<string> = new Set([
  '302ai',
  'aihubmix',
  'aionly',
  'alayanew',
  'baichuan',
  'burncloud',
  'cerebras',
  'dmxapi',
  'fireworks',
  'gateway',
  'gpustack',
  'groq',
  'lanyun',
  'longcat',
  'ocoolai',
  'omlx',
  'ph8',
  'poe',
  'ppio',
  'qiniu',
  'sophnet',
  'together',
  'tokendance',
  'voyageai',
  'xirang'
] satisfies SystemProviderId[])

export function isExcludedProviderPreset(providerId: string): boolean {
  return excludedProviderPresetIds.has(providerId)
}

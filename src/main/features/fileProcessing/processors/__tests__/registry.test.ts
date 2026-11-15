import { describe, expect, it, vi } from 'vitest'

import { FILE_PROCESSOR_FEATURES } from '@shared/data/preference/preferenceTypes'
import { PRESETS_FILE_PROCESSORS } from '@shared/data/presets/fileProcessing'

type Platform = {
  isLinux: boolean
  isMac: boolean
  isWin: boolean
  isDarwinX64?: boolean
  isWinArm64?: boolean
}

async function importRegistryWithPlatform(platform: Platform) {
  vi.resetModules()
  vi.doMock('@main/core/platform', () => ({
    isLinux: platform.isLinux,
    isMac: platform.isMac,
    isWin: platform.isWin,
    isDarwinX64: platform.isDarwinX64 ?? false,
    isWinArm64: platform.isWinArm64 ?? false
  }))

  const { processorRegistry } = await import('../registry')
  return processorRegistry
}

describe('processorRegistry', () => {
  it('registers retained preset capabilities and excludes image OCR', async () => {
    const processorRegistry = await importRegistryWithPlatform({ isLinux: false, isMac: true, isWin: false })

    for (const preset of PRESETS_FILE_PROCESSORS) {
      const registryEntry = processorRegistry[preset.id]

      expect(registryEntry, `${preset.id} registry entry`).toBeDefined()

      if (!registryEntry.isSupported()) {
        expect(registryEntry.capabilities).toEqual({})
        continue
      }

      for (const capability of preset.capabilities) {
        if (capability.feature === 'image_to_text') {
          expect(registryEntry.capabilities[capability.feature]).toBeUndefined()
          continue
        }
        expect(
          registryEntry.capabilities[capability.feature],
          `${preset.id}.${capability.feature} registry handler`
        ).toBeDefined()
      }
    }
  })

  it('does not register handlers for unsupported preset capabilities', async () => {
    const processorRegistry = await importRegistryWithPlatform({ isLinux: false, isMac: true, isWin: false })

    for (const preset of PRESETS_FILE_PROCESSORS) {
      const supportedFeatures = new Set(preset.capabilities.map((capability) => capability.feature))
      const registeredFeatures = Object.keys(processorRegistry[preset.id].capabilities)

      expect(registeredFeatures.every((feature) => FILE_PROCESSOR_FEATURES.includes(feature as never))).toBe(true)

      for (const feature of registeredFeatures) {
        expect(supportedFeatures.has(feature as never), `${preset.id}.${feature} unsupported handler`).toBe(true)
      }
    }
  })

  it.each([
    { isLinux: true, isMac: false, isWin: false },
    { isLinux: false, isMac: true, isWin: false, isDarwinX64: true },
    { isLinux: false, isMac: true, isWin: false },
    { isLinux: false, isMac: false, isWin: true },
    { isLinux: false, isMac: false, isWin: true, isWinArm64: true }
  ])('keeps retired local processors disabled on every platform %#', async (platform) => {
    const processorRegistry = await importRegistryWithPlatform(platform)
    for (const id of ['tesseract', 'system', 'local-paddleocr', 'local-document', 'ovocr'] as const) {
      expect(processorRegistry[id].isSupported(), id).toBe(false)
      expect(processorRegistry[id].capabilities, id).toEqual({})
    }
    for (const id of ['paddleocr', 'mineru', 'doc2x', 'mistral', 'open-mineru'] as const) {
      expect(processorRegistry[id].isSupported(), id).toBe(true)
      expect(processorRegistry[id].capabilities.document_to_markdown, id).toBeDefined()
    }
  })
})

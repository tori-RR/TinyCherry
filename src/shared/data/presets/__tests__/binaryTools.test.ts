import { describe, expect, it } from 'vitest'

import enUs from '../../../../renderer/i18n/locales/en-us.json'
import { isRuntimeDependency, PRESETS_BINARY_TOOLS, RUNTIME_INTERPRETERS } from '../binaryTools'

describe('isRuntimeDependency', () => {
  it('recognizes every registered interpreter, bare or with core:/@version', () => {
    for (const runtime of RUNTIME_INTERPRETERS) {
      expect(isRuntimeDependency(runtime)).toBe(true)
      expect(isRuntimeDependency(`core:${runtime}`)).toBe(true)
      expect(isRuntimeDependency(`${runtime}@1.2.3`)).toBe(true)
    }
  })

  it('rejects package-backend and unrelated specs', () => {
    expect(isRuntimeDependency('npm:ntn')).toBe(false)
    expect(isRuntimeDependency('pipx:something')).toBe(false)
    expect(isRuntimeDependency('gh')).toBe(false)
    expect(isRuntimeDependency('ruby')).toBe(false)
  })
})

describe('preset descriptions', () => {
  // The dependency card interpolates `tool.name` into the key, so a renamed preset
  // renders the raw `settings.dependencies.tools.<name>` string instead of a description.
  it.each(PRESETS_BINARY_TOOLS.map(({ name }) => name))('%s resolves to a description in en-us.json', (name) => {
    expect(typeof (enUs as Record<string, string>)[`settings.dependencies.tools.${name}`]).toBe('string')
  })
})

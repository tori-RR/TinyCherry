import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

import { rendererAliases, rendererDefines } from './build/renderer.config'
import pkg from './package.json'

// Vite 8 is pinned and uses its bundled config loader in this CommonJS tooling workspace.
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true'
process.env.TZ = 'UTC'
process.stdout.setMaxListeners(64)
process.stderr.setMaxListeners(64)
const aliases = rendererAliases
const project = (
  name: string,
  include: string[],
  environment: 'node' | 'jsdom' = 'node',
  setupFiles: string[] = []
) => ({
  extends: true as const,
  resolve: { alias: aliases },
  plugins: environment === 'jsdom' ? [react()] : [],
  test: { name, include, environment, setupFiles }
})
export default defineConfig({
  define: { ...rendererDefines(pkg.version), __DESKTOP_DEV_ORIGIN__: 'null' },
  test: {
    globals: true,
    // Native Canvas/image bindings share process state on Windows. A worker
    // process keeps one file's native teardown from invalidating another file.
    pool: 'forks',
    maxWorkers: process.env.CI ? '50%' : 4,
    testTimeout: 20000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.cache/**'],
    projects: [
      project('renderer', ['src/renderer/**/*.{test,spec}.{ts,tsx}'], 'jsdom', [
        '@vitest/web-worker',
        'tests/renderer.setup.ts'
      ]),
      project('desktop', ['src/platform/**/*.{test,spec}.{ts,tsx}'], 'jsdom', ['tests/renderer.setup.ts']),
      project('shared', ['src/shared/**/*.{test,spec}.{ts,tsx}']),
      project('ui', ['packages/ui/src/**/*.{test,spec}.{ts,tsx}']),
      {
        ...project('file-preview', ['packages/file-preview/src/**/*.test.{ts,tsx}'], 'jsdom', [
          '@vitest/web-worker',
          'tests/file-preview.setup.ts'
        ]),
        // PDF integration loads a native Canvas binding. On Windows its native
        // state must be isolated by a process rather than shared worker threads.
        test: {
          name: 'file-preview',
          environment: 'jsdom',
          pool: 'forks',
          setupFiles: ['@vitest/web-worker', 'tests/file-preview.setup.ts'],
          include: ['packages/file-preview/src/**/*.test.{ts,tsx}']
        },
        resolve: {
          alias: [
            { find: /^@cherrystudio\/ui$/, replacement: resolve('packages/file-preview/src/bundledUi.ts') },
            ...Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }))
          ]
        }
      },
      project('provider-registry', ['packages/provider-registry/**/*.{test,spec}.{ts,tsx}']),
      project('web-search', ['packages/web-search/src/**/__tests__/**/*.test.ts']),
      project('remote-protocol', ['packages/remote-protocol/tests/**/*.{test,spec}.{ts,tsx}']),
      project('tooling', ['scripts/uiContract/**/*.{test,spec}.{ts,tsx}'])
    ]
  }
})

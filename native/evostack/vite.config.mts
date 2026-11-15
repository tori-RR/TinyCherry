import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { rendererAliases, rendererDefines } from '../../build/renderer.config'
import pkg from '../../package.json'
import { uiContractPlugin } from '../../scripts/uiContract/vitePlugin'

const rootPath = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const adapterPath = (path: string) => rootPath(`src/renderer/windows/evostack/${path}`)

export default defineConfig({
  root: rootPath('src/renderer'),
  base: './',
  cacheDir: fileURLToPath(new URL('.cache/vite', import.meta.url)),
  plugins: [
    {
      name: 'evostack-window-controls',
      enforce: 'pre',
      load(id) {
        if (
          id.replaceAll('\\', '/') ===
          rootPath('src/renderer/components/WindowControls/WindowControls.tsx').replaceAll('\\', '/')
        ) {
          return readFileSync(adapterPath('WindowControls.tsx'), 'utf8')
        }
      }
    },
    uiContractPlugin(),
    tailwindcss(),
    react()
  ],
  define: rendererDefines(pkg.version),
  resolve: {
    alias: [
      { find: /^electron$/, replacement: adapterPath('electronShim.ts') },
      { find: /^@electron-toolkit\/preload$/, replacement: adapterPath('toolkitPreload.ts') },
      { find: /^@renderer\/services\/sentry$/, replacement: adapterPath('sentry.ts') },
      { find: /^@renderer\/components\/WindowControls$/, replacement: adapterPath('WindowControls.tsx') },
      ...Object.entries(rendererAliases).map(([find, replacement]) => ({
        find,
        replacement
      }))
    ]
  },
  worker: { format: 'es' },
  build: {
    rolldownOptions: { input: adapterPath('index.html') },
    outDir: fileURLToPath(new URL('dist/frontend', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022'
  }
})

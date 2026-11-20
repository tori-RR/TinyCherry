import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import { rendererAliases, rendererDefines } from '../../build/renderer.config'
import pkg from '../../package.json'
import { uiContractPlugin } from '../../scripts/uiContract/vitePlugin'

const rootPath = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))

export default defineConfig(({ command }) => ({
  root: rootPath('src/renderer'),
  base: './',
  cacheDir: fileURLToPath(new URL('.vite', import.meta.url)),
  plugins: [uiContractPlugin(), tailwindcss(), react()],
  define: {
    ...rendererDefines(pkg.version),
    __DESKTOP_DEV_ORIGIN__: JSON.stringify(command === 'serve' ? 'http://127.0.0.1:17420' : null)
  },
  resolve: { alias: rendererAliases },
  server: {
    host: '127.0.0.1',
    port: 17420,
    strictPort: true,
    headers: {
      'X-TinyCherry-Dev-Owner': process.env.TINYCHERRY_DEV_OWNER ?? 'standalone',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src http://127.0.0.1:17420 ws://127.0.0.1:17420; worker-src 'self' blob:; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    },
    fs: {
      allow: [rootPath('')],
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/.cache/**',
        '**/.pnpm-store/**',
        '**/evostack-data/**',
        '**/.code_review/**',
        '**/README_LOG.*',
        '**/*.local.md',
        '**/AGENTS*',
        '**/.agents/**',
        '**/.claude/**',
        '**/local/**'
      ]
    },
    watch: { ignored: ['**/native/evostack/.cache/**', '**/.cache/**', '**/dist/**'] }
  },
  worker: { format: 'es' },
  build: {
    rolldownOptions: { input: rootPath('src/renderer/windows/evostack/index.html') },
    outDir: fileURLToPath(new URL('dist/frontend', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022'
  }
}))

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { native, root } from './process.mjs'

export function prepareEnvironment() {
  // Never replace a user's ignore policy or install Git hooks. Fresh checkouts
  // get generic exclusions before commands can create a profile or build cache.
  if (!existsSync(resolve(root, '.gitignore')))
    copyFileSync(resolve(root, '.gitignore.template'), resolve(root, '.gitignore'))
  const cache = resolve(native, '.cache')
  for (const name of ['tmp', 'go', 'go-build', 'cargo', 'target', 'npm', 'pnpm'])
    mkdirSync(resolve(cache, name), { recursive: true })
  Object.assign(process.env, {
    TEMP: resolve(cache, 'tmp'),
    TMP: resolve(cache, 'tmp'),
    GOPATH: resolve(cache, 'go'),
    GOMODCACHE: resolve(cache, 'go/pkg/mod'),
    GOCACHE: resolve(cache, 'go-build'),
    GOTOOLCHAIN: 'local',
    CGO_ENABLED: '0',
    CARGO_HOME: resolve(cache, 'cargo'),
    CARGO_TARGET_DIR: resolve(cache, 'target'),
    npm_config_cache: resolve(cache, 'npm'),
    npm_config_store_dir: resolve(root, '.pnpm-store'),
    RUSTUP_NO_UPDATE_CHECK: '1',
    VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true'
  })
}

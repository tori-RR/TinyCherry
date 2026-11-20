import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'
import { parseAllDocuments } from 'yaml'

import { root } from './process.mjs'

const retiredDependency =
  /^(?:electron(?:$|-)|@electron(?:\/|-)|@electron-toolkit\/|@paymoapp\/electron|@sentry\/electron|@tauri-apps\/|app-builder-lib$|builder-util(?:-runtime)?$|@earendil-works\/pi-|@anthropic-ai\/claude-agent-sdk$)/
const retired = (name) => name !== 'electron-to-chromium' && retiredDependency.test(name)
const packageName = (key) => key.slice(0, key.indexOf('@', key.startsWith('@') ? 1 : 0))
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

export function hasRetiredRuntimeSurface(text, file = 'source.ts') {
  const imports = ts.preProcessFile(text, true, true).importedFiles
  if (
    imports.some(
      ({ fileName }) =>
        fileName === 'electron' ||
        fileName.startsWith('electron/') ||
        fileName.startsWith('@electron-toolkit/') ||
        fileName.startsWith('@tauri-apps/') ||
        /(?:^@?|\/)platform\/tauri(?:\/|$)/.test(fileName)
    )
  )
    return true
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  let found = false
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ((node.expression.text === 'window' && ['electron', '__TAURI__'].includes(node.name.text)) ||
        node.expression.text === 'Electron')
    )
      found = true
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'window' &&
      ts.isStringLiteral(node.argumentExpression) &&
      ['electron', '__TAURI__'].includes(node.argumentExpression.text)
    )
      found = true
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && node.left.text === 'Electron') found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Includes optional and peer edges, not just the root dependency declarations. */
export function checkDependencyGraph(documents) {
  const problems = []
  const edges = (owner, node) => {
    for (const group of dependencyGroups)
      for (const name of Object.keys(node?.[group] ?? {}))
        if (retired(name)) problems.push(`Retired ${group} edge: ${owner} -> ${name}`)
  }
  for (const document of documents) {
    for (const [name, node] of Object.entries(document.importers ?? {})) edges(name, node)
    for (const group of ['packages', 'snapshots'])
      for (const [key, node] of Object.entries(document[group] ?? {})) {
        const name = packageName(key)
        if (retired(name)) problems.push(`Retired resolved package: ${key}`)
        edges(key, node)
      }
  }
  return [...new Set(problems)]
}

export function checkInstalledStore(directory, virtualStoreDir = '.pnpm') {
  if (typeof virtualStoreDir !== 'string' || !virtualStoreDir) throw new Error('Invalid pnpm virtualStoreDir')
  // pnpm's modules manifest resolves relative virtualStoreDir from node_modules.
  const store = resolve(directory, 'node_modules', virtualStoreDir)
  return existsSync(store)
    ? readdirSync(store)
        .filter((entry) => retired(packageName(entry).replace('+', '/')))
        .map((entry) => `Retired installed package: ${entry}`)
    : []
}

export function checkExit(directory = root) {
  const read = (name) => readFileSync(resolve(directory, name), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const problems = []
  for (const group of dependencyGroups)
    for (const name of Object.keys(pkg[group] ?? {})) if (retired(name)) problems.push(`Retired dependency: ${name}`)
  const documents = parseAllDocuments(read('pnpm-lock.yaml')).map((document) => {
    if (document.errors.length) throw document.errors[0]
    return document.toJS()
  })
  problems.push(...checkDependencyGraph(documents))
  // Inspect the installed store too: a clean lock alone cannot prove a stale
  // install directory is suitable for development or packaging.
  const modulesPath = resolve(directory, 'node_modules/.modules.yaml')
  if (existsSync(modulesPath)) {
    const [modules] = parseAllDocuments(readFileSync(modulesPath, 'utf8'))
    if (modules.errors.length) throw modules.errors[0]
    problems.push(...checkInstalledStore(directory, modules.toJS().virtualStoreDir))
  }
  for (const [name, script] of Object.entries(pkg.scripts))
    if (/legacy:|electron|tauri|pre-commit|install-hooks|postinstall/.test(`${name} ${script}`))
      problems.push(`Retired command: ${name}`)
  for (const name of [
    'src/main',
    'src/preload',
    'src/utility',
    'electron.vite.config.ts',
    'electron.vite.entries.config.ts',
    'electron-builder.yml',
    'src/platform/tauri',
    'native/evostack/src-tauri',
    'tsconfig.tauri.json'
  ])
    if (existsSync(resolve(directory, name))) problems.push(`Retired active tree: ${name}`)
  const files = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '.',
      ':(exclude,glob)**/node_modules/**',
      ':(exclude,glob)**/.cache/**',
      ':(exclude,glob)**/.vite/**',
      ':(exclude,glob)**/dist/**',
      ':(exclude,glob)**/.pnpm-store/**'
    ],
    {
      cwd: directory,
      encoding: 'utf8'
    }
  )
    .split('\0')
    .filter(Boolean)
  for (const file of files) {
    if (
      !existsSync(resolve(directory, file)) ||
      !/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(file) ||
      /^(?:docs\/|resources\/|patches\/|\.agents\/)/.test(file)
    )
      continue
    if (!/^(src\/|build\/|native\/|scripts\/|tests\/|packages\/|\.github\/|vitest|package\.json|pnpm-)/.test(file))
      continue
    const source = read(file)
    if (/\.[cm]?[jt]sx?$/.test(file) && hasRetiredRuntimeSurface(source, file))
      problems.push(`Retired runtime surface: ${file}`)
  }
  for (const file of ['native/evostack/src-gpui/Cargo.toml', 'native/evostack/src-gpui/Cargo.lock']) {
    if (!existsSync(resolve(directory, file))) {
      problems.push(`Missing GPUI host build input: ${file}`)
      continue
    }
    if (/^\s*(?:name\s*=\s*"tauri(?:-[^"]*)?"|tauri(?:-[\w-]+)?\s*=)/m.test(read(file)))
      problems.push(`Retired Tauri host dependency: ${file}`)
  }
  if (problems.length) throw new Error(problems.join('\n'))
  console.log('GPUI + Wry exit gate passed')
}
if (process.argv[1]?.endsWith('exit-gate.mjs')) checkExit()

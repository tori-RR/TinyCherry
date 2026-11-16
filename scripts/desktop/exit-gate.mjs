import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import ts from 'typescript'
import { parseAllDocuments } from 'yaml'

import { root } from './process.mjs'

const retiredDependency =
  /^(?:electron(?:$|-)|@electron(?:\/|-)|@electron-toolkit\/|@paymoapp\/electron|@sentry\/electron|app-builder-lib$|builder-util(?:-runtime)?$|@earendil-works\/pi-|@anthropic-ai\/claude-agent-sdk$)/
const retired = (name) => name !== 'electron-to-chromium' && retiredDependency.test(name)
const packageName = (key) => key.slice(0, key.indexOf('@', key.startsWith('@') ? 1 : 0))
const dependencyGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

export function hasRetiredRuntimeSurface(text, file = 'source.ts') {
  const imports = ts.preProcessFile(text, true, true).importedFiles
  if (
    imports.some(
      ({ fileName }) =>
        fileName === 'electron' || fileName.startsWith('electron/') || fileName.startsWith('@electron-toolkit/')
    )
  )
    return true
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  let found = false
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ((node.expression.text === 'window' && node.name.text === 'electron') || node.expression.text === 'Electron')
    )
      found = true
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'window' &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'electron'
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
    const store = modules.toJS().virtualStoreDir
    if (store && existsSync(store))
      for (const entry of readdirSync(store))
        if (retired(packageName(entry).replace('+', '/'))) problems.push(`Retired installed package: ${entry}`)
  }
  for (const [name, script] of Object.entries(pkg.scripts))
    if (/legacy:|electron|pre-commit|install-hooks|postinstall/.test(`${name} ${script}`))
      problems.push(`Retired command: ${name}`)
  for (const name of [
    'src/main',
    'src/preload',
    'src/utility',
    'electron.vite.config.ts',
    'electron.vite.entries.config.ts',
    'electron-builder.yml'
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
  if (problems.length) throw new Error(problems.join('\n'))
  console.log('Tauri-only exit gate passed')
}
if (process.argv[1]?.endsWith('exit-gate.mjs')) checkExit()

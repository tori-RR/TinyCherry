import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

import { checkCatalogPolicy, checkWorkflowPolicy } from '../validation/upstreamPolicy.mjs'

const directories: string[] = []
const requiredCiJobs = [
  'changes',
  'basic-checks',
  'main-test-shard',
  'renderer-test-shard',
  'package-test',
  'platform-test',
  'general-test',
  'render-test'
]

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workflowFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cherry-upstream-workflow-'))
  directories.push(root)
  cpSync('.github/workflows', join(root, '.github/workflows'), { recursive: true })
  return root
}

function editWorkflow(root: string, file: string, edit: (workflow: ReturnType<typeof parse>) => void) {
  const path = join(root, '.github/workflows', file)
  const workflow = parse(readFileSync(path, 'utf8'))
  edit(workflow)
  writeFileSync(path, stringify(workflow))
}

describe('upstream-only workflow policy', () => {
  it('keeps catalog publication and notifications upstream-only while preserving fork CI', () => {
    expect(() => checkWorkflowPolicy(process.cwd())).not.toThrow()
  })

  it.each(['sync-registry-data.yml', 'ci.yml'])('rejects a missing owner guard in %s', (file) => {
    const root = workflowFixture()
    editWorkflow(root, file, (workflow) => {
      delete workflow.jobs[file === 'ci.yml' ? 'notify' : 'sync'].if
    })
    expect(() => checkWorkflowPolicy(root)).toThrow('must require the upstream repository guard')
  })

  it.each(['sync-registry-data.yml', 'ci.yml'])('rejects an OR that bypasses the owner guard in %s', (file) => {
    const root = workflowFixture()
    editWorkflow(root, file, (workflow) => {
      workflow.jobs[file === 'ci.yml' ? 'notify' : 'sync'].if += ' || true'
    })
    expect(() => checkWorkflowPolicy(root)).toThrow('must require the upstream repository guard')
  })

  it('accepts the GitHub expression wrapper around a mandatory guard', () => {
    const root = workflowFixture()
    editWorkflow(root, 'ci.yml', (workflow) => {
      workflow.jobs.notify.if = `\${{ ${workflow.jobs.notify.if} }}`
    })
    expect(() => checkWorkflowPolicy(root)).not.toThrow()
  })

  it.each(requiredCiJobs)('rejects owner restrictions on the real CI job %s', (job) => {
    const root = workflowFixture()
    editWorkflow(root, 'ci.yml', (workflow) => {
      workflow.jobs[job].if = "github.repository == 'CherryHQ/cherry-studio'"
    })
    expect(() => checkWorkflowPolicy(root)).toThrow(`Required CI job must remain enabled for forks: ${job}`)
  })

  it.each(requiredCiJobs)('rejects disabling or removing the real CI job %s', (job) => {
    const root = workflowFixture()
    editWorkflow(root, 'ci.yml', (workflow) => {
      workflow.jobs[job].if = false
    })
    expect(() => checkWorkflowPolicy(root)).toThrow('must remain enabled for forks')
    editWorkflow(root, 'ci.yml', (workflow) => {
      delete workflow.jobs[job]
    })
    expect(() => checkWorkflowPolicy(root)).toThrow(`Required CI job is missing: ${job}`)
  })
})

function catalogFixture() {
  const root = mkdtempSync(join(tmpdir(), 'cherry-upstream-catalog-'))
  directories.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'catalog fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  write('packages/provider-registry/data/models.json', '[]\n')
  const base = commit()
  return { root, base, write, commit, git }
}

describe('generated provider catalog policy', () => {
  it('rejects committed data changes without source changes, even when unrelated files also changed', () => {
    const fixture = catalogFixture()
    fixture.write('packages/provider-registry/data/models.json', '[{}]\n')
    fixture.write('README.md', 'unrelated\n')
    fixture.commit()
    expect(() => checkCatalogPolicy(fixture.root, fixture.base)).toThrow('without provider source or scripts')
  })

  it.each(['src/providers/model.ts', 'scripts/generate.ts'])(
    'accepts catalog changes accompanied by provider %s',
    (source) => {
      const fixture = catalogFixture()
      fixture.write('packages/provider-registry/data/models.json', '[{}]\n')
      fixture.write(`packages/provider-registry/${source}`, 'export const model = {}\n')
      fixture.commit()
      expect(() => checkCatalogPolicy(fixture.root, fixture.base)).not.toThrow()
    }
  )

  it('does not accept an unstaged source file as evidence for committed catalog edits', () => {
    const fixture = catalogFixture()
    fixture.write('packages/provider-registry/data/models.json', '[{}]\n')
    fixture.commit()
    fixture.write('packages/provider-registry/src/providers/model.ts', 'export const model = {}\n')
    expect(() => checkCatalogPolicy(fixture.root, fixture.base)).toThrow('without provider source or scripts')
  })

  it('rejects deleting generated data without source changes', () => {
    const fixture = catalogFixture()
    fixture.git('rm', 'packages/provider-registry/data/models.json')
    fixture.commit()
    expect(() => checkCatalogPolicy(fixture.root, fixture.base)).toThrow('without provider source or scripts')
  })

  it('allows unrelated changes and fails closed when the fixed comparison base is missing', () => {
    const fixture = catalogFixture()
    fixture.write('README.md', 'unrelated\n')
    fixture.commit()
    expect(() => checkCatalogPolicy(fixture.root, fixture.base)).not.toThrow()
    expect(() => checkCatalogPolicy(fixture.root, 'missing-base')).toThrow()
  })
})

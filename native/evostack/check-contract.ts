import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { InstalledSkillSchema } from '../../src/shared/data/api/schemas/skills'
import { AssistantSchema } from '../../src/shared/data/types/assistant'
import {
  KnowledgeBaseSchema,
  KnowledgeItemChunkSchema,
  KnowledgeItemSchema,
  KnowledgeSearchResultSchema
} from '../../src/shared/data/types/knowledge'
import { MessageSchema } from '../../src/shared/data/types/message'
import { ModelSchema } from '../../src/shared/data/types/model'
import {
  PromptBindingRelationSchema,
  PromptBindingTargetSchema,
  PromptSchema
} from '../../src/shared/data/types/prompt'
import { ProviderSchema } from '../../src/shared/data/types/provider'
import { TopicSchema } from '../../src/shared/data/types/topic'
import { fileRequestSchemas } from '../../src/shared/ipc/schemas/file'
import { skillRequestSchemas } from '../../src/shared/ipc/schemas/skill'

async function main(): Promise<void> {
  const root = resolve(__dirname)
  const evidence = resolve(root, '.cache', `contract-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  const syntheticKey = 'evostack-local-contract-test-only'
  let providerCalls = 0
  const service = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`)
    providerCalls++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"EvoStack 真实协议通过"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  const address = service.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const child = spawn(
    process.env.EVOSTACK_BACKEND_EXECUTABLE ?? resolve(root, 'dist/portable/tinycherry-evostack-backend.exe'),
    ['--data-dir', evidence],
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const events: any[] = []
  let nextId = 1
  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line)
    assert.equal(frame.jsonrpc, '2.0')
    if (frame.method === 'event') events.push(frame.params)
    else {
      const callback = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) callback?.reject(new Error(frame.error.message))
      else callback?.resolve(frame.result)
    }
  })
  child.on('exit', () => {
    for (const value of pending.values()) value.reject(new Error('backend exited'))
    pending.clear()
  })
  const rpc = (method: string, params: unknown): Promise<any> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout ${method}`))
      }, 10_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
  const invoke = (channel: string, ...args: unknown[]) => rpc('ipc.invoke', { channel, args })
  const data = async (method: string, path: string, body?: unknown) => {
    const response = await invoke('data-api:request', { id: `test-${nextId}`, method, path, body })
    assert(!response.error, response.error?.message)
    return response.data
  }
  const command = async (route: string, input: unknown) => {
    const response = await invoke('ipc-api:request', route, input)
    assert.equal(response.ok, true, response.error?.message)
    return response.data
  }
  const preview = async (file: string, expectedText: string) => {
    // Exercise the original preview adapter's strict metadata/read version comparison,
    // including files whose filesystem timestamp has a fractional millisecond.
    utimesSync(file, 1_700_000_000.123456, 1_700_000_000.123456)
    const handle = { kind: 'path', path: file }
    const metadata = fileRequestSchemas['file.get_metadata'].output.parse(await command('file.get_metadata', handle))
    assert(metadata?.kind === 'file')
    const wire = await command('file.read', { handle, options: { mode: 'full', encoding: 'binary' } })
    assert(Array.isArray(wire.content))
    assert(wire.content.every((byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255))
    const read = fileRequestSchemas['file.read'].output.parse({ ...wire, content: Uint8Array.from(wire.content) })
    assert.equal(read.version.mtime, Math.floor(metadata.modifiedAt))
    assert.equal(read.version.size, metadata.size)
    assert.equal(read.content.byteLength, metadata.size)
    assert(Buffer.from(read.content).toString('utf8').includes(expectedText))
  }
  try {
    assert.equal((await rpc('backend.info', null)).backend, 'go')
    const provider = ProviderSchema.parse(
      await data('POST', '/providers', {
        providerId: 'evostack-contract',
        name: 'EvoStack contract',
        endpointConfigs: { 'openai-chat-completions': { baseUrl } }
      })
    )
    await data('POST', `/providers/${provider.id}/api-keys`, { key: syntheticKey })
    const [model] = await data('POST', '/models', [{ providerId: provider.id, modelId: 'local-test' }])
    ModelSchema.parse(model)
    const assistant = AssistantSchema.parse(
      await data('POST', '/assistants', { name: '原界面助手', modelId: model.id })
    )
    const prompt = PromptSchema.parse(
      await data('POST', '/prompts', {
        title: '契约提示词',
        content: '保留原始提示词内容',
        visibility: 'restricted',
        bindingTarget: { type: 'assistant', id: assistant.id }
      })
    )
    assert(
      PromptSchema.array()
        .parse(await data('GET', '/prompts'))
        .some((item) => item.id === prompt.id)
    )
    assert.deepEqual(PromptBindingTargetSchema.array().parse(await data('GET', `/prompts/${prompt.id}/bindings`)), [
      { type: 'assistant', id: assistant.id }
    ])
    assert.deepEqual(PromptBindingRelationSchema.array().parse(await data('GET', '/prompt-bindings')), [
      { promptId: prompt.id, targetType: 'assistant', targetId: assistant.id }
    ])
    assert.equal(
      PromptSchema.array().parse(await data('GET', `/prompt-bindings/assistant/${assistant.id}`))[0].id,
      prompt.id
    )

    const catalog = await command('skill.list_catalog', {})
    assert(Array.isArray(catalog) && catalog.length > 0)
    for (const { scope, ...skill } of catalog) {
      assert.equal(scope, 'builtin')
      InstalledSkillSchema.parse(skill)
    }
    assert.equal(InstalledSkillSchema.array().parse(await data('GET', '/skills')).length, catalog.length)
    const builtin = catalog.find((item) => item.folderName === 'skill-creator')
    assert(builtin)
    InstalledSkillSchema.parse(await data('GET', `/skills/${builtin.id}`))
    const folder = skillRequestSchemas['skill.folder.resolve'].output.parse(
      await command('skill.folder.resolve', { skillId: builtin.id })
    )
    assert.equal(folder.access, 'read_only')
    await preview(resolve(folder.rootPath, 'SKILL.md'), 'name: skill-creator')

    const knowledge = KnowledgeBaseSchema.parse(
      await command('knowledge.create_base', { base: { name: '契约知识库' } })
    )
    KnowledgeBaseSchema.parse(await data('GET', `/knowledge-bases/${knowledge.id}`))
    await command('knowledge.import_text', {
      baseId: knowledge.id,
      name: 'contract.txt',
      content: 'EvoStackContractFixture 知识库契约测试。'
    })
    const knowledgeItems = await data('GET', `/knowledge-bases/${knowledge.id}/items`)
    const [knowledgeItem] = KnowledgeItemSchema.array().parse(knowledgeItems.items)
    assert(knowledgeItem)
    KnowledgeItemSchema.parse(await data('GET', `/knowledge-items/${knowledgeItem.id}`))
    const chunks = KnowledgeItemChunkSchema.array().parse(
      await command('knowledge.list_item_chunks', { baseId: knowledge.id, itemId: knowledgeItem.id })
    )
    assert(chunks.length > 0 && chunks.every((chunk) => chunk.itemId === knowledgeItem.id))
    const hits = KnowledgeSearchResultSchema.array().parse(
      await command('knowledge.search', { baseId: knowledge.id, query: 'EvoStackContractFixture' })
    )
    assert(hits.some((hit) => hit.itemId === knowledgeItem.id))
    await preview(await command('knowledge.get_file_path', { itemId: knowledgeItem.id }), 'EvoStackContractFixture')

    const topic = TopicSchema.parse(await data('POST', '/topics', { assistantId: assistant.id }))
    const open = await invoke('ipc-api:request', 'ai.stream.open', {
      topicId: topic.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text: '协议测试' }]
    })
    assert.equal(open.ok, true, open.error?.message)
    assert.equal(open.data.mode, 'started')
    const deadline = Date.now() + 10_000
    while (!events.some((event) => event.args[0] === 'ai.stream.done')) {
      if (Date.now() > deadline) throw new Error('stream did not complete')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const branch = await data('GET', `/topics/${topic.id}/messages`)
    assert.equal(branch.items.length, 2)
    for (const { message } of branch.items) MessageSchema.parse(message)
    assert.equal(
      branch.items[1].message.data.parts
        .flatMap((part: { type: string; text?: string }) => (part.type === 'text' ? [part.text] : []))
        .join(''),
      'EvoStack 真实协议通过'
    )
    assert.equal(branch.items[1].message.status, 'success')
    assert.equal(providerCalls, 1)
    const unsupported = await invoke('ipc-api:request', 'ai.agent.create', { name: 'unsupported' })
    assert.equal(unsupported.ok, false)
    assert.match(unsupported.error.message, /NOT_MIGRATED/)
    const prefs = await invoke('preference:get-all')
    assert(Object.keys(prefs).length > 100)
    const db = readFileSync(resolve(evidence, 'evostack.sqlite3'))
    const wal = readFileSync(resolve(evidence, 'evostack.sqlite3-wal'))
    assert(!db.includes(Buffer.from(syntheticKey)) && !wal.includes(Buffer.from(syntheticKey)))
    writeFileSync(
      resolve(evidence, 'result.json'),
      JSON.stringify(
        {
          ok: true,
          schemaChecks: [
            'provider',
            'model',
            'assistant',
            'topic',
            'message',
            'prompt[]',
            'prompt-bindings',
            'skill-catalog',
            'installed-skill',
            'file-metadata',
            'file-read-binary',
            'preview-version',
            'knowledge-base',
            'knowledge-item',
            'knowledge-chunk',
            'knowledge-search'
          ],
          providerCalls,
          events: events.length
        },
        null,
        2
      )
    )
    process.stdout.write(`contract passed: ${evidence}\n`)
    await rpc('backend.shutdown', null)
  } finally {
    child.stdin.end()
    await new Promise<void>((resolve) => service.close(() => resolve()))
  }
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})

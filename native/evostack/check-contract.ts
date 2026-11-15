import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { applyMessageProjectionUpdate } from '../../src/shared/ai/messageProjection'
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
import { NotificationRecordSchema } from '../../src/shared/data/types/notification'
import {
  PromptBindingRelationSchema,
  PromptBindingTargetSchema,
  PromptSchema
} from '../../src/shared/data/types/prompt'
import { ProviderSchema } from '../../src/shared/data/types/provider'
import { TopicSchema } from '../../src/shared/data/types/topic'
import { aiRequestSchemas } from '../../src/shared/ipc/schemas/ai'
import { assistantRequestSchemas } from '../../src/shared/ipc/schemas/assistant'
import { fileRequestSchemas } from '../../src/shared/ipc/schemas/file'
import { notificationRequestSchemas } from '../../src/shared/ipc/schemas/notification'
import { skillRequestSchemas } from '../../src/shared/ipc/schemas/skill'

async function main(): Promise<void> {
  const root = resolve(__dirname)
  const evidence = resolve(root, '.cache', `contract-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  const syntheticKey = 'evostack-local-contract-test-only'
  let providerCalls = 0
  let invalidProbe = false
  const requests: any[] = []
  const service = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`)
    providerCalls++
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const payload = JSON.parse(body)
      requests.push(payload)
      if (payload.stream === false) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify(
            invalidProbe
              ? { error: { message: 'synthetic error despite HTTP 200' } }
              : {
                  id: 'contract',
                  object: 'chat.completion',
                  created: 1,
                  model: payload.model,
                  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
                }
          )
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"EvoStack 真实协议通过"}}]}\n\n')
      if (payload.messages.some((message: any) => message.content === '停止契约测试')) response.flushHeaders()
      else response.end('data: [DONE]\n\n')
    })
  })
  const proxyRequests: { url: string; header: string | undefined }[] = []
  const proxy = createServer((request, response) => {
    proxyRequests.push({ url: request.url ?? '', header: request.headers['x-evostack-contract'] as string | undefined })
    assert.equal(request.url, 'http://audit.invalid/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end('data: {"choices":[{"delta":{"content":"proxy loopback only"}}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  const address = service.address()
  assert(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  assert(proxyAddress && typeof proxyAddress === 'object')
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
    if (frame.method === 'host.computer') {
      assert.equal(frame.params.operation, 'configure', 'Plain contracts must never control the desktop')
      assert.equal(frame.params.enabled, false)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true, data: {} } })}\n`)
    } else if (frame.method === 'event') events.push(frame.params)
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
  const data = async (method: string, path: string, body?: unknown, params?: unknown) => {
    const response = await invoke('data-api:request', { id: `test-${nextId}`, method, path, body, params })
    assert(!response.error, response.error?.message)
    return response.data
  }
  const command = async (route: string, input: unknown) => {
    const response = await invoke('ipc-api:request', route, input)
    assert.equal(response.ok, true, response.error?.message)
    return response.data
  }
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('contract observation timed out')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const waitDone = (topicId: string, from: number) =>
    waitFor(() => {
      const observed = events.slice(from)
      const failure = observed.find((event) => event.args[0] === 'ai.stream.error' && event.args[1].topicId === topicId)
      assert(!failure, failure?.args[1]?.error?.message)
      return observed.some((event) => event.args[0] === 'ai.stream.done' && event.args[1].topicId === topicId)
    })
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
    assert.equal(await invoke('preference:get', 'app.computer_use.agent_control.enabled'), true)
    await invoke('preference:set', 'app.computer_use.agent_control.enabled', false)
    await invoke('preference:set', 'app.proxy.mode', 'none')
    const provider = ProviderSchema.parse(
      await data('POST', '/providers', {
        providerId: 'evostack-contract',
        name: 'EvoStack contract',
        endpointConfigs: { 'openai-chat-completions': { baseUrl } }
      })
    )
    await data('POST', `/providers/${provider.id}/api-keys`, { key: syntheticKey })
    const [model] = await data('POST', '/models', [{ providerId: provider.id, modelId: 'vendor/local-test' }])
    ModelSchema.parse(model)
    assert.equal(ModelSchema.parse(await data('GET', `/models/${model.id}`)).id, model.id)
    const assistant = AssistantSchema.parse(
      await data('POST', '/assistants', { name: '原界面助手', modelId: model.id })
    )
    const imageBytes = Uint8Array.from(Buffer.from('UklGRiIAAABXRUJQVlA4TBUAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64'))
    const avatarInput = assistantRequestSchemas['assistant.set_avatar'].input.parse({
      assistantId: assistant.id,
      avatar: { kind: 'image', data: imageBytes }
    })
    assistantRequestSchemas['assistant.set_avatar'].output.parse(
      await command('assistant.set_avatar', {
        ...avatarInput,
        avatar: { ...avatarInput.avatar, data: [...imageBytes] }
      })
    )
    const withAvatar = AssistantSchema.parse(await data('GET', `/assistants/${assistant.id}`))
    assert(withAvatar.avatarFileId && withAvatar.avatarSrc?.startsWith('data:image/webp;base64,'))
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
    const subscriptionId = randomUUID()
    const projectionInput = { target: { kind: 'topic' as const, topicId: topic.id }, subscriptionId }
    let projection = aiRequestSchemas['ai.projection.attach'].output.parse(
      await command('ai.projection.attach', aiRequestSchemas['ai.projection.attach'].input.parse(projectionInput))
    )
    assert(projection?.kind === 'topic' && projection.messages.length === 0)
    const streamStart = events.length
    const open = await invoke('ipc-api:request', 'ai.stream.open', {
      topicId: topic.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text: '协议测试' }]
    })
    assert.equal(open.ok, true, open.error?.message)
    assert.equal(open.data.mode, 'started')
    await waitDone(topic.id, streamStart)
    for (const event of events.slice(streamStart)) {
      if (event.args[0] !== 'ai.projection.changed' || event.args[1].subscriptionId !== subscriptionId) continue
      const next = applyMessageProjectionUpdate(projection, event.args[1].update)
      assert(next, 'original shared projection consumer rejected Go revision or patch')
      projection = next
    }
    assert(projection?.kind === 'topic')
    assert.equal(projection.executions[0]?.status, 'done')
    assert.equal(
      projection.messages[0].parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(''),
      'EvoStack 真实协议通过'
    )
    aiRequestSchemas['ai.projection.detach'].output.parse(await command('ai.projection.detach', projectionInput))
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
    assert.equal(branch.items[1].message.messageSnapshot.avatarFileId, withAvatar.avatarFileId)
    assert.equal(providerCalls, 1)

    assistantRequestSchemas['assistant.set_avatar'].output.parse(
      await command('assistant.set_avatar', { assistantId: assistant.id, avatar: { kind: 'default' } })
    )
    const resetAvatar = AssistantSchema.parse(await data('GET', `/assistants/${assistant.id}`))
    assert.equal(resetAvatar.avatarFileId, undefined)
    assert.equal(resetAvatar.emoji, withAvatar.emoji)
    const avatarRead = await command('file.read', {
      handle: { kind: 'entry', entryId: withAvatar.avatarFileId },
      options: { mode: 'full', encoding: 'binary' }
    })
    const historicalAvatar = fileRequestSchemas['file.read'].output.parse({
      ...avatarRead,
      content: Uint8Array.from(avatarRead.content)
    })
    assert.deepEqual(historicalAvatar.content, imageBytes)
    assert.equal(historicalAvatar.mime, 'image/webp')

    const notificationPage = await data('GET', '/notifications', undefined, { limit: 1 })
    const [notification] = NotificationRecordSchema.array().parse(notificationPage.items)
    assert(notification?.target?.kind === 'conversation')
    assert.equal(notification.target.conversationId, topic.id)
    assert.equal(notification.target.result?.status, 'succeeded')
    assert.equal(notificationPage.nextCursor, undefined)
    assert.deepEqual(await data('GET', '/notifications/unread-count'), { count: 1 })
    const presented = events.find(
      (event) => event.args[0] === 'notification.present' && event.args[1].id === notification.id
    )
    NotificationRecordSchema.parse(presented?.args[1])
    const navigationStart = events.length
    notificationRequestSchemas['notification.activate'].output.parse(
      await command('notification.activate', { id: notification.id })
    )
    const navigation = events
      .slice(navigationStart)
      .find((event) => event.args[0] === 'navigation.conversation_focus_or_open_requested')
    assert.deepEqual(navigation?.args[1].target, { conversationType: 'assistant', conversationId: topic.id })
    assert.deepEqual(await data('GET', '/notifications/unread-count'), { count: 0 })
    assert.equal(await data('DELETE', `/notifications/${notification.id}`), undefined)
    assert.deepEqual((await data('GET', '/notifications')).items, [])

    const temporary = aiRequestSchemas['ai.temporary_topic.create'].output.parse(
      await command('ai.temporary_topic.create', { assistantId: assistant.id })
    )
    const temporaryStart = events.length
    await command('ai.stream.open', {
      topicId: temporary.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text: '临时会话契约测试' }]
    })
    await waitDone(temporary.id, temporaryStart)
    assert(!(await data('GET', '/topics')).items.some((item: { id: string }) => item.id === temporary.id))
    assert.deepEqual((await data('GET', '/notifications')).items, [])
    const temporaryBranch = await data('GET', `/topics/${temporary.id}/messages`)
    for (const { message } of temporaryBranch.items) MessageSchema.parse(message)
    aiRequestSchemas['ai.temporary_topic.persist'].output.parse(
      await command('ai.temporary_topic.persist', { id: temporary.id })
    )
    const persisted = TopicSchema.parse(await data('GET', `/topics/${temporary.id}`))
    assert.equal(persisted.activeNodeId, temporaryBranch.activeNodeId)
    assert.equal(persisted.createdAt, temporary.createdAt)
    assert.deepEqual((await data('GET', `/topics/${temporary.id}/messages`)).items, temporaryBranch.items)
    const discarded = TopicSchema.parse(await command('ai.temporary_topic.create', {}))
    aiRequestSchemas['ai.temporary_topic.delete'].output.parse(
      await command('ai.temporary_topic.delete', { id: discarded.id })
    )

    const stopping = TopicSchema.parse(await data('POST', '/topics', { assistantId: assistant.id }))
    const stopStart = events.length
    await command('ai.stream.open', {
      topicId: stopping.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text: '停止契约测试' }]
    })
    await waitFor(() =>
      events
        .slice(stopStart)
        .some(
          (event) =>
            event.args[0] === 'ai.stream.chunk' &&
            event.args[1].topicId === stopping.id &&
            event.args[1].chunk.type === 'text-delta'
        )
    )
    aiRequestSchemas['ai.stream.abort'].output.parse(await command('ai.stream.abort', { topicId: stopping.id }))
    await waitDone(stopping.id, stopStart)
    const stopped = await data('GET', `/topics/${stopping.id}/messages`)
    const stoppedReply = MessageSchema.parse(stopped.items[1].message)
    assert.equal(stoppedReply.status, 'paused')
    assert(stoppedReply.data.parts?.some((part) => part.type === 'text' && part.text.length > 0))
    const stoppedResult = NotificationRecordSchema.array().parse((await data('GET', '/notifications')).items)
    assert(stoppedResult.some((record) => record.target?.result?.status === 'cancelled' && record.readAt !== null))

    aiRequestSchemas['ai.provider.model.check'].output.parse(
      await command('ai.provider.model.check', { uniqueModelId: model.id })
    )
    invalidProbe = true
    const invalidHealth = await invoke('ipc-api:request', 'ai.provider.model.check', { uniqueModelId: model.id })
    assert.equal(invalidHealth.ok, false, 'HTTP 200 error body was accepted as a model completion')
    invalidProbe = false

    await invoke('preference:set', 'app.proxy.mode', 'custom')
    await invoke('preference:set', 'app.proxy.url', `http://127.0.0.1:${proxyAddress.port}`)
    await data('PATCH', `/providers/${provider.id}`, {
      endpointConfigs: { 'openai-chat-completions': { baseUrl: 'http://audit.invalid/v1' } },
      providerSettings: { extraHeaders: { 'X-EvoStack-Contract': 'local-only' } }
    })
    const proxied = TopicSchema.parse(await data('POST', '/topics', { assistantId: assistant.id }))
    const proxyStart = events.length
    await command('ai.stream.open', {
      topicId: proxied.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text: '本地代理契约测试' }]
    })
    await waitDone(proxied.id, proxyStart)
    assert.deepEqual(proxyRequests, [{ url: 'http://audit.invalid/v1/chat/completions', header: 'local-only' }])
    assert.equal(
      (await data('GET', `/topics/${proxied.id}/messages`)).items[1].message.searchableText,
      'proxy loopback only'
    )
    assert(requests.every((request) => request.model === 'vendor/local-test'))
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
            'knowledge-search',
            'assistant-avatar-webp',
            'historical-avatar-file-read',
            'message-projection-consumer',
            'notification-record',
            'notification-read-dismiss-activate',
            'temporary-chat-persist-discard',
            'stream-stop-partial',
            'model-health-200-error',
            'custom-proxy-loopback-and-headers',
            'model-greedy-id'
          ],
          providerCalls,
          proxyCalls: proxyRequests.length,
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
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

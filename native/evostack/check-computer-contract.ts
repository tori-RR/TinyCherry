import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { readUIMessageStream, type UIMessage, type UIMessageChunk, uiMessageChunkSchema } from 'ai'

import {
  applyMessageProjectionUpdate,
  type MessageProjectionView,
  type TopicProjectionState
} from '../../src/shared/ai/messageProjection'
import { MessageDataSchema, MessageSchema } from '../../src/shared/data/types/message'
import { computerUseRequestSchemas } from '../../src/shared/ipc/schemas/computerUse'

async function main(): Promise<void> {
  const root = resolve(__dirname)
  const evidence = resolve(root, '.cache', `computer-contract-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  const syntheticKey = 'computer-contract-loopback-only'
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const requests: any[] = []
  let abortedRequests = 0
  let releasePlain: (() => void) | undefined
  let fatal: unknown
  const service = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', async () => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${syntheticKey}`)
        const payload = JSON.parse(body)
        requests.push(payload)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const toolResults = payload.messages.filter((message: any) => message.role === 'tool')
        const frame = (delta: unknown, finishReason?: string) =>
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta, ...(finishReason ? { finish_reason: finishReason } : {}) }] })}\n\n`
          )
        if (JSON.stringify(payload.messages).includes('Abort synthetic projection')) {
          response.once('close', () => abortedRequests++)
          frame({ content: 'Partial cancellation proof' })
          return
        }
        if (!payload.tools) {
          frame({ content: 'Plain ' })
          await new Promise<void>((done) => {
            releasePlain = done
            response.once('close', done)
          })
          if (response.destroyed) return
          frame({ content: 'SSE contract passed.' })
          await new Promise((done) => setTimeout(done, 160))
          frame({}, 'stop')
        } else if (toolResults.length < 2) {
          assert.equal(payload.parallel_tool_calls, false)
          assert.equal(payload.tools.length, 9)
          assert(!payload.tools.some((tool: any) => tool.function.name === 'mcp__computer__press_key'))
          const observing = toolResults.length === 0
          const name = observing ? 'mcp__computer__get_app_state' : 'mcp__computer__click'
          const args = observing
            ? { appSessionId: 'contract-session' }
            : { appSessionId: 'contract-session', snapshotId: 'snapshot-1', elementId: 'fixture-button' }
          const encoded = JSON.stringify(args)
          frame({
            tool_calls: [
              {
                index: 0,
                id: observing ? 'observe-call' : 'click-call',
                type: 'function',
                function: { name, arguments: encoded.slice(0, 7) }
              }
            ]
          })
          frame({ tool_calls: [{ index: 0, function: { arguments: encoded.slice(7) } }] }, 'tool_calls')
        } else {
          frame({ content: 'Computer tool ' })
          await new Promise((done) => setTimeout(done, 160))
          frame({ content: 'contract passed.' })
          await new Promise((done) => setTimeout(done, 160))
          frame({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        fatal = error
        response.destroy()
      }
    })
  })
  await new Promise<void>((done) => service.listen(0, '127.0.0.1', done))
  const address = service.address()
  assert(address && typeof address === 'object')
  const child = spawn(
    process.env.EVOSTACK_BACKEND_EXECUTABLE ?? resolve(root, 'dist/portable/tinycherry-evostack-backend.exe'),
    ['--data-dir', evidence],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const events: any[] = []
  const nativeCalls: string[] = []
  const grantedTasks = new Set<string>()
  let closedTasks = 0
  let nextId = 1
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  const fail = (error: unknown) => {
    fatal = error
    for (const callback of pending.values()) callback.reject(error instanceof Error ? error : new Error(String(error)))
    pending.clear()
  }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Contract backend exited')))
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const frame = JSON.parse(line)
      assert.equal(frame.jsonrpc, '2.0')
      if (frame.method === 'host.computer') {
        const params = frame.params
        let result: any = {}
        if (params.operation === 'invoke') {
          assert(grantedTasks.has(params.taskId), 'Desktop task was used before its private open grant')
          nativeCalls.push(params.tool)
          assert.equal(params.ownerId.length, 36)
          assert.equal(params.taskId.length, 36)
          assert(['get_app_state', 'click'].includes(params.tool), 'Only the synthetic contract tools may execute')
          const snapshot = {
            id: params.tool === 'click' ? 'snapshot-2' : 'snapshot-1',
            appSessionId: 'contract-session',
            tree: { status: 'available', text: 'fixture-button button "Synthetic button"' },
            screenshot: {
              status: 'available',
              image: { mimeType: 'image/png', width: 1, height: 1, dataBase64: screenshot }
            }
          }
          result =
            params.tool === 'click' ? { status: 'completed', observation: { status: 'available', snapshot } } : snapshot
        } else if (params.operation === 'close_task') closedTasks++
        else assert.equal(params.operation, 'configure')
        // The process is a fake reverse host; it never launches a native helper.
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true, data: result } })}\n`)
      } else if (frame.method === 'host.computer.cancel') {
        // No action is running when the test shuts down.
      } else if (frame.method === 'event') events.push(frame.params)
      else {
        if (frame.computerTaskId !== undefined) {
          assert.match(frame.computerTaskId, /^[0-9a-f-]{36}$/)
          assert.equal(frame.result.ok, true)
          assert.equal(frame.result.data.mode, 'started')
          assert(!('computerTaskId' in frame.result.data), 'Private grant leaked into the renderer acknowledgement')
          grantedTasks.add(frame.computerTaskId)
        }
        const callback = pending.get(frame.id)
        pending.delete(frame.id)
        if (frame.error) callback?.reject(new Error(frame.error.message))
        else callback?.resolve(frame.result)
      }
    } catch (error) {
      fail(error)
    }
  })
  const rpc = (method: string, params: unknown): Promise<any> => {
    const id = nextId++
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Contract request timed out: ${method}`))
      }, 10_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          done(value)
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
    const result = await invoke('data-api:request', { id: `contract-${nextId}`, method, path, body })
    assert(!result.error, result.error?.message)
    return result.data
  }
  const command = async (route: string, input: unknown) => {
    const result = await invoke('ipc-api:request', route, input)
    assert(result.ok, result.error?.message)
    return result.data
  }
  const waitFor = async (condition: () => boolean, description: string) => {
    const end = Date.now() + 10_000
    while (!condition()) {
      if (fatal) throw fatal
      const failure = events.find((event) => event.channel === 'ipc-api:event' && event.args[0] === 'ai.stream.error')
      assert(!failure, failure?.args[1]?.error?.message)
      assert(Date.now() < end, description)
      await new Promise((done) => setTimeout(done, 10))
    }
  }
  const projectionEvents = (subscriptionId: string) =>
    events
      .filter((event) => event.channel === 'ipc-api:event' && event.args[0] === 'ai.projection.changed')
      .map((event) => event.args[1])
      .filter((event) => event.subscriptionId === subscriptionId)
  const validateView = (view: MessageProjectionView<TopicProjectionState>, topicId: string) => {
    assert.equal(view.kind, 'topic')
    assert.equal(view.topicId, topicId)
    assert(Number.isSafeInteger(view.revision) && view.revision >= 0)
    assert.equal(new Set(view.messages.map((message) => message.id)).size, view.messages.length)
    for (const message of view.messages) MessageDataSchema.parse({ parts: message.parts })
  }
  const applyEvents = (baseline: MessageProjectionView<TopicProjectionState>, subscriptionId: string) => {
    let view = baseline
    for (const { update } of projectionEvents(subscriptionId)) {
      assert.equal(update.revision, view.revision + 1, 'Projection delivery lost or reordered a revision')
      const next = applyMessageProjectionUpdate(view, update)
      assert(next, 'The original renderer rejected a projection patch or message order')
      view = next
      validateView(view, baseline.topicId)
    }
    return view
  }
  const run = async (assistantId: string, text: string, reconnect = false, abort = false) => {
    const topic = await data('POST', '/topics', { assistantId })
    const target = { kind: 'topic', topicId: topic.id }
    let subscriptionId = randomUUID()
    let baseline: MessageProjectionView<TopicProjectionState> = await command('ai.projection.attach', {
      target,
      subscriptionId
    })
    validateView(baseline, topic.id)
    assert.deepEqual(baseline.messages, [])
    const originalBaseline = baseline
    const originalSerialized = JSON.stringify(baseline)
    const ack = await command('ai.stream.open', {
      topicId: topic.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text }]
    })
    assert.equal(ack.mode, 'started', 'The start acknowledgement must remain compatible with the new dispatcher')
    if (reconnect || abort) {
      await waitFor(
        () =>
          applyEvents(baseline, subscriptionId).messages.some((message) =>
            message.parts.some((part) => part.type === 'text' && part.text.length > 0)
          ),
        'The new renderer projection did not receive partial text'
      )
    }
    if (reconnect) {
      assert(applyEvents(baseline, subscriptionId).executions.some((execution) => execution.status === 'active'))
      const detached = subscriptionId
      await command('ai.projection.detach', { target, subscriptionId: detached })
      const detachedEventCount = projectionEvents(detached).length
      subscriptionId = randomUUID()
      baseline = await command('ai.projection.attach', { target, subscriptionId })
      validateView(baseline, topic.id)
      assert(baseline.messages.some((message) => message.parts.some((part) => part.type === 'text')))
      assert(baseline.executions.some((execution) => execution.status === 'active'))
      releasePlain?.()
      releasePlain = undefined
      await waitFor(
        () =>
          projectionEvents(subscriptionId).some(({ update }) =>
            update.patches.some((patch: any) => patch.type === 'append')
          ),
        'The reconnected renderer did not receive incremental append patches'
      )
      assert.equal(
        projectionEvents(detached).length,
        detachedEventCount,
        'Detached projection continued delivering events'
      )
    }
    if (abort) await command('ai.stream.abort', { topicId: topic.id })
    const end = Date.now() + 10_000
    while (
      !events.some(
        (event) =>
          event.channel === 'ipc-api:event' && event.args[0] === 'ai.stream.done' && event.args[1].topicId === topic.id
      )
    ) {
      if (fatal) throw fatal
      const failure = events.find(
        (event) =>
          event.channel === 'ipc-api:event' && event.args[0] === 'ai.stream.error' && event.args[1].topicId === topic.id
      )
      assert(!failure, failure?.args[1]?.error?.message)
      assert(Date.now() < end, 'Model turn did not terminate')
      await new Promise((done) => setTimeout(done, 20))
    }
    const validateChunk = uiMessageChunkSchema().validate
    assert(validateChunk)
    const chunks: UIMessageChunk[] = await Promise.all(
      events
        .filter(
          (event) =>
            event.channel === 'ipc-api:event' &&
            event.args[0] === 'ai.stream.chunk' &&
            event.args[1].topicId === topic.id
        )
        .map(async (event) => {
          const result = await validateChunk(event.args[1].chunk)
          if (!result.success) throw result.error
          return result.value
        })
    )
    let message: UIMessage | undefined
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      }
    })
    for await (const value of readUIMessageStream({ stream, terminateOnError: true })) message = value
    assert(message)
    const branch = await data('GET', `/topics/${topic.id}/messages`)
    const stored = MessageSchema.parse(branch.items.find((item: any) => item.message.id === message?.id).message)
    assert.equal(stored.status, abort ? 'paused' : 'success')
    assert.deepEqual(
      JSON.parse(JSON.stringify(message.parts)),
      stored.data.parts,
      'Live SDK projection and durable DTO differ'
    )
    const projection = applyEvents(baseline, subscriptionId)
    assert.equal(JSON.stringify(originalBaseline), originalSerialized, 'Attach baseline mutated after delivery')
    assert(projection.executions.some((execution) => execution.status === (abort ? 'paused' : 'done')))
    const projected = projection.messages.find((item) => item.id === stored.id)
    assert(projected)
    assert.deepEqual(projected.parts, stored.data.parts, 'New renderer projection and durable DTO differ')
    const replayBaseline = await command('ai.projection.attach', { target, subscriptionId })
    assert.deepEqual(replayBaseline, projection, 'Reconnect baseline differs from the applied live projection')
    await command('ai.projection.detach', { target, subscriptionId })
    return { message, stored, chunks, projection, revisions: projectionEvents(subscriptionId).length, reconnect }
  }
  try {
    const provider = await data('POST', '/providers', {
      providerId: 'computer-contract',
      name: 'Computer contract',
      endpointConfigs: { 'openai-chat-completions': { baseUrl: `http://127.0.0.1:${address.port}/v1` } }
    })
    await data('POST', `/providers/${provider.id}/api-keys`, { key: syntheticKey })
    const [model] = await data('POST', '/models', [
      {
        providerId: provider.id,
        modelId: 'fixture',
        inputModalities: ['text', 'image'],
        capabilities: ['function-call', 'image-recognition']
      }
    ])
    const assistant = await data('POST', '/assistants', { name: 'Computer contract', modelId: model.id })
    assert.equal(await invoke('preference:get', 'app.computer_use.agent_control.enabled'), true)
    assert.deepEqual(
      computerUseRequestSchemas['computer_use.get_approvals'].output.parse(await command('computer_use.get_approvals')),
      []
    )
    assert.equal(
      computerUseRequestSchemas['computer_use.respond_approval'].output.parse(
        await command('computer_use.respond_approval', { approvalId: randomUUID(), scope: 'session' })
      ),
      false
    )
    await invoke('preference:set', 'app.computer_use.agent_control.enabled', false)
    const plain = await run(assistant.id, 'Plain text only', true)
    assert(plain.message.parts.some((part) => part.type === 'text' && part.text === 'Plain SSE contract passed.'))
    assert.equal(nativeCalls.length, 0)
    await invoke('preference:set', 'app.computer_use.agent_control.enabled', true)
    const tool = await run(assistant.id, 'Use only the synthetic fixture application')
    assert.deepEqual(nativeCalls, ['get_app_state', 'click'])
    const dynamic = tool.message.parts.filter((part) => part.type === 'dynamic-tool')
    assert.equal(dynamic.length, 2)
    for (const part of dynamic) {
      assert.equal(part.state, 'output-available')
      assert.deepEqual(part.callProviderMetadata?.cherry, {
        tool: { type: 'builtin', serverId: 'computer', serverName: 'computer' }
      })
    }
    assert(tool.message.parts.some((part) => part.type === 'text' && part.text === 'Computer tool contract passed.'))
    assert(!JSON.stringify(tool.stored).includes(screenshot), 'Screenshot leaked into SQLite message')
    assert(!JSON.stringify(tool.chunks).includes(screenshot), 'Screenshot leaked into replay frames')
    assert(!JSON.stringify(tool.projection).includes(screenshot), 'Screenshot leaked into renderer projection')
    for (const payload of requests.filter(
      (payload) => payload.tools && payload.messages.some((message: any) => message.role === 'tool')
    )) {
      const images = payload.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url') : []
      )
      assert.equal(images.length, 1, 'Only the most recent screenshot may remain in model context')
      assert.equal(images[0].image_url.url, `data:image/png;base64,${screenshot}`)
    }
    assert.equal(closedTasks, 1)
    assert.equal(grantedTasks.size, 1)
    await invoke('preference:set', 'app.computer_use.agent_control.enabled', false)
    const aborted = await run(assistant.id, 'Abort synthetic projection', false, true)
    assert(aborted.message.parts.some((part) => part.type === 'text' && part.text === 'Partial cancellation proof'))
    await waitFor(() => abortedRequests === 1, 'Abort did not close the owned provider request')
    const result = {
      passed: true,
      modelRequests: requests.length,
      nativeCalls,
      privateOpenGrants: grantedTasks.size,
      plainSdkParts: plain.message.parts.length,
      toolSdkParts: tool.message.parts.length,
      screenshotPersisted: false,
      originalSdkAndStoredPartsEqual: true,
      rendererProjectionAndStoredPartsEqual: true,
      incrementalReconnect: plain.reconnect,
      projectionRevisions: { plain: plain.revisions, tool: tool.revisions, aborted: aborted.revisions },
      abortStatus: aborted.stored.status,
      abortedRequests
    }
    writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2))
    process.stdout.write(`computer contract passed: ${evidence}\n`)
    await rpc('backend.shutdown', null)
  } catch (error) {
    writeFileSync(
      resolve(evidence, 'failure.json'),
      JSON.stringify({ error: String(error), events, requests }, null, 2)
    )
    throw error
  } finally {
    releasePlain?.()
    child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      exited,
      new Promise<void>((done) => {
        timer = setTimeout(() => {
          child.kill()
          done()
        }, 3000)
      })
    ])
    if (timer) clearTimeout(timer)
    await new Promise<void>((done) => service.close(() => done()))
  }
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { readUIMessageStream, type UIMessage, type UIMessageChunk, uiMessageChunkSchema } from 'ai'

import { MessageSchema } from '../../src/shared/data/types/message'

async function main(): Promise<void> {
  const root = resolve(__dirname)
  const evidence = resolve(root, '.cache', `computer-contract-${Date.now()}`)
  mkdirSync(evidence, { recursive: true })
  const syntheticKey = 'computer-contract-loopback-only'
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const requests: any[] = []
  let fatal: unknown
  const service = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
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
        if (!payload.tools) frame({ content: 'Plain SSE contract passed.' }, 'stop')
        else if (toolResults.length < 2) {
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
        } else frame({ content: 'Computer tool contract passed.' }, 'stop')
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
  const run = async (assistantId: string, text: string) => {
    const topic = await data('POST', '/topics', { assistantId })
    await command('ai.stream.open', {
      topicId: topic.id,
      trigger: 'submit-message',
      userMessageParts: [{ type: 'text', text }]
    })
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
    assert.equal(stored.status, 'success')
    assert.deepEqual(
      JSON.parse(JSON.stringify(message.parts)),
      stored.data.parts,
      'Live SDK projection and durable DTO differ'
    )
    return { message, stored, chunks }
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
    const plain = await run(assistant.id, 'Plain text only')
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
    for (const payload of requests.slice(2)) {
      const images = payload.messages.flatMap((message: any) =>
        Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url') : []
      )
      assert.equal(images.length, 1, 'Only the most recent screenshot may remain in model context')
      assert.equal(images[0].image_url.url, `data:image/png;base64,${screenshot}`)
    }
    assert.equal(closedTasks, 1)
    assert.equal(grantedTasks.size, 1)
    const result = {
      passed: true,
      modelRequests: requests.length,
      nativeCalls,
      privateOpenGrants: grantedTasks.size,
      plainSdkParts: plain.message.parts.length,
      toolSdkParts: tool.message.parts.length,
      screenshotPersisted: false,
      originalSdkAndStoredPartsEqual: true
    }
    writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(result, null, 2))
    process.stdout.write(`computer contract passed: ${evidence}\n`)
    await rpc('backend.shutdown', null)
  } finally {
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

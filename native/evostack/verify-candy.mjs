import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve, sep } from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4zxAKRAwQCgAn5gVRIZSlFQAAAABJRU5ErkJggg=='
const CONTENT = 'Candy native agent wrote this after approval.'

/** Exercise the shipped React pages, Wry IPC, Go tools and persisted image files. */
export async function verifyCandy({ evaluate, command, until, profile }) {
  const counters = { chat: 0, images: 0 }
  const responses = new Set()
  const failures = []
  let imageCancelled = false
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.authorization, 'Bearer synthetic-candy-smoke-only')
        const payload = JSON.parse(body)
        if (request.url === '/v1/images/generations') {
          counters.images++
          assert.equal(payload.model, 'gpt-image-1')
          if (payload.prompt === 'Candy cancelled image') {
            responses.add(response)
            response.once('close', () => {
              imageCancelled = true
              responses.delete(response)
            })
          } else {
            assert.equal(payload.prompt, 'Candy persisted image')
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ data: [{ b64_json: PNG }] }))
          }
          return
        }
        assert.equal(request.url, '/v1/chat/completions')
        assert.equal(payload.stream, true)
        assert(payload.tools.some((tool) => tool.function.name === 'write_file'))
        counters.chat++
        const user = JSON.stringify(payload.messages.findLast((message) => message.role === 'user').content)
        const last = payload.messages.at(-1)
        const send = (delta, finish) => {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.end(
            `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n` +
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n` +
              'data: [DONE]\n\n'
          )
        }
        const tool = (id, name, input) =>
          send(
            { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
            'tool_calls'
          )
        if (user.includes('Candy approved tool')) {
          if (last.role !== 'tool') tool('candy-write', 'write_file', { path: 'approved.txt', content: CONTENT })
          else if (last.tool_call_id === 'candy-write') {
            assert.equal(JSON.parse(last.content).bytesWritten, Buffer.byteLength(CONTENT))
            tool('candy-read', 'read_file', { path: 'approved.txt' })
          } else {
            assert.equal(JSON.parse(last.content).content, CONTENT)
            send({ content: 'Candy agent verified file' }, 'stop')
          }
        } else if (user.includes('Candy denied tool')) {
          if (last.role !== 'tool')
            tool('candy-denied', 'write_file', { path: 'denied.txt', content: 'must not exist' })
          else {
            assert.match(last.content, /denied/)
            send({ content: 'Candy denial respected' }, 'stop')
          }
        } else if (user.includes('Candy stop approval')) {
          assert.notEqual(last.role, 'tool', 'A stopped approval must not continue the tool loop')
          tool('candy-stopped', 'write_file', { path: 'stopped.txt', content: 'must not exist' })
        } else throw new Error('Unexpected synthetic agent prompt')
      } catch (error) {
        failures.push(error.message)
        response.writeHead(500)
        response.end(JSON.stringify({ error: { message: error.message } }))
      }
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const visible = (selector) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0)`
  const click = async (selector) => {
    await until(
      `Boolean((()=>{const node=${visible(selector)};return node&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'})())`
    )
    await evaluate(`(()=>{const node=${visible(selector)};node.click()})()`)
  }
  const fill = async (selector, text) => {
    await until(`Boolean(${visible(selector)})`)
    await evaluate(`(()=>{const node=${visible(selector)};node.focus();if(node.select)node.select()})()`)
    await command('Input.insertText', { text })
  }
  const open = async (path, selector) => {
    assert(
      await evaluate(
        `(()=>{const event=new CustomEvent('cherry:open-main-route',{cancelable:true,detail:{path:${JSON.stringify(path)}}});window.dispatchEvent(event);return event.defaultPrevented})()`
      )
    )
    await until(`Boolean(${visible(selector)})`)
  }
  const screenshot = async (name) => {
    const result = await command('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(profile, name), Buffer.from(result.data, 'base64'))
  }
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
    await evaluate(`(async()=>{
      const data=async(method,path,body)=>{const r=await window.api.dataApi.request({method,path,body});if(r.error)throw Error(r.error.message);return r.data};
      const provider=await data('POST','/providers',{providerId:'evostack-candy-smoke',name:'Candy local provider',endpointConfigs:{'openai-chat-completions':{baseUrl:${JSON.stringify(baseUrl)}}}});
      await data('PATCH','/providers/'+provider.id,{isEnabled:true});
      await data('POST','/providers/'+provider.id+'/api-keys',{key:'synthetic-candy-smoke-only'});
      const models=await data('POST','/models',[
        {providerId:provider.id,modelId:'candy-work',name:'Candy work model',capabilities:['function-call']},
        {providerId:provider.id,modelId:'gpt-image-1',name:'Candy painting model',capabilities:['image-generation']}
      ]);
      for(const model of models)await data('PATCH','/models/'+model.id,{isEnabled:true});
      await window.api.preference.set('chat.default_model_id',models[0].id);
      await window.api.preference.set('feature.paintings.default_model_id',models[1].id);
      await window.api.preference.set('feature.paintings.default_provider',provider.id);
    })()`)
    await command('Page.reload', {})
    await until('Boolean(window.api?.ipcApi?.request && document.querySelector(\'[data-ui~="app.content"]\'))')
    await open('/app/agents', '[data-testid="agent-page"]')
    await click('[data-testid="agent-create"]')
    await fill('[data-testid="agent-name"]', 'Candy native worker')
    await fill('[data-testid="agent-instructions"]', 'Use workspace tools and obey each approval decision.')
    await click('[data-testid="agent-save"]')
    await until('!document.querySelector(\'[data-testid="agent-editor"]\')')
    await click('[data-testid="agent-session-create"]')
    await until(`Boolean(${visible('[data-testid="agent-conversation"]')})`)
    const session = await evaluate(
      `(async()=>{const r=await window.api.dataApi.request({method:'GET',path:'/agent-sessions/latest'});if(r.error)throw Error(r.error.message);return r.data.session})()`
    )
    assert(session?.workspace?.path, 'Creating work must persist an owned workspace')
    assert(
      resolve(session.workspace.path)
        .toLowerCase()
        .startsWith(resolve(profile).toLowerCase() + sep)
    )
    const submit = async (text) => {
      await fill('[data-testid="agent-composer"] [contenteditable="true"]', text)
      await click('[data-testid="agent-composer"] [data-ui~="chat.composer.action.send"]')
    }
    await submit('Candy approved tool')
    await until(`Boolean(${visible('[data-testid="agent-tool-approve"]')})`)
    assert(!existsSync(join(session.workspace.path, 'approved.txt')), 'A proposed file edit ran before approval')
    await click('[data-testid="agent-tool-approve"]')
    await until(
      `document.body.textContent.includes('Candy agent verified file')&&!(${visible('[data-testid="agent-stop"]')})`
    )
    assert.equal(readFileSync(join(session.workspace.path, 'approved.txt'), 'utf8'), CONTENT)
    await submit('Candy denied tool')
    await click('[data-testid="agent-tool-reject"]')
    await until(
      `document.body.textContent.includes('Candy denial respected')&&!(${visible('[data-testid="agent-stop"]')})`
    )
    assert(!existsSync(join(session.workspace.path, 'denied.txt')))
    await submit('Candy stop approval')
    await until(`Boolean(${visible('[data-testid="agent-tool-approve"]')})`)
    await click('[data-testid="agent-stop"]')
    await until(`!(${visible('[data-testid="agent-stop"]')})&&!(${visible('[data-testid="agent-tool-approve"]')})`)
    assert(!existsSync(join(session.workspace.path, 'stopped.txt')))
    assert.equal(counters.chat, 6, 'Agent actions must not replay after approval, denial or stop')
    await screenshot('workspace-agents.png')
    await command('Page.reload', {})
    await until('Boolean(window.api?.ipcApi?.request && document.querySelector(\'[data-ui~="app.content"]\'))')
    await open(`/app/agents?sessionId=${encodeURIComponent(session.id)}`, '[data-testid="agent-conversation"]')
    await until(
      "document.body.textContent.includes('Candy agent verified file')&&document.body.textContent.includes('Candy denial respected')"
    )
    assert.equal(counters.chat, 6, 'Reloading history must not resume a stopped agent action')

    await open('/app/paintings/evostack-candy-smoke', '[data-testid="painting-page"]')
    await fill('[data-testid="painting-prompt"]', 'Candy persisted image')
    await click('[data-testid="painting-generate"]')
    await until(
      `Boolean([...document.querySelectorAll('[data-testid="painting-history-card"] img')].find(node=>node.getBoundingClientRect().width>0&&node.complete&&node.naturalWidth>0))`
    )
    assert.equal(counters.images, 1, 'One Generate click must issue one provider request')
    const paintingId = await evaluate(
      `${visible('[data-testid="painting-history-card"]')}.getAttribute('data-painting-id')`
    )
    assert(paintingId)
    await screenshot('workspace-paintings.png')
    await click('[data-testid="painting-preview-open"]')
    await until(
      `Boolean([...document.querySelectorAll('[role="dialog"] [data-testid="painting-image"]')].find(image=>image.complete&&image.naturalWidth===2))`
    )
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await until('!document.querySelector(\'[role="dialog"]\')')
    await command('Page.reload', {})
    await until('Boolean(window.api?.ipcApi?.request && document.querySelector(\'[data-ui~="app.content"]\'))')
    await open('/app/paintings/evostack-candy-smoke', '[data-testid="painting-page"]')
    await until(
      `Boolean([...document.querySelectorAll('[data-testid="painting-history-card"]')].find(node=>node.getAttribute('data-painting-id')===${JSON.stringify(paintingId)}&&[...node.querySelectorAll('img')].some(image=>image.complete&&image.naturalWidth>0)))`
    )
    assert.equal(counters.images, 1, 'Reloading painting history must not issue another paid request')
    await fill('[data-testid="painting-prompt"]', 'Candy cancelled image')
    await click('[data-testid="painting-generate"]')
    const startDeadline = Date.now() + 5000
    while (counters.images < 2 && Date.now() < startDeadline) await new Promise((done) => setTimeout(done, 50))
    assert.equal(counters.images, 2, 'The cancellable image request must have reached the owned provider')
    await click('[data-testid="painting-cancel"]')
    const stopDeadline = Date.now() + 5000
    while (!imageCancelled && Date.now() < stopDeadline) await new Promise((done) => setTimeout(done, 50))
    assert(imageCancelled, 'Cancelling a painting must close its provider request')
    await until(
      `window.api.ipcApi.request('painting.generate.list').then(r=>r.ok&&r.data.some(job=>job.prompt==='Candy cancelled image'&&job.status==='cancelled'))`
    )
    assert.equal(counters.images, 2)
    assert.deepEqual(failures, [])
    return {
      agentCreate: true,
      workspace: true,
      approvedFile: true,
      deniedFile: true,
      stoppedApproval: true,
      agentHistory: true,
      painting: true,
      paintingHistory: true,
      paintingCancel: true,
      noReplay: true
    }
  } finally {
    for (const response of responses) response.destroy()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

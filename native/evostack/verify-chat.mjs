import assert from 'node:assert/strict'
import { createServer } from 'node:http'

/** A real React composer -> Tauri -> Go -> loopback provider round trip. */
export async function verifyChat({ evaluate, command, until, localeCatalogs }) {
  let streams = 0,
    stopped = false
  const responses = new Set()
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/v1/chat/completions' ||
      request.headers.authorization !== 'Bearer synthetic-ui-smoke-only'
    ) {
      response.writeHead(400)
      response.end()
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) request.destroy()
    })
    request.on('end', () => {
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      if (payload.stream !== true) {
        response.writeHead(400)
        response.end()
        return
      }
      streams++
      const partial = payload.messages.some((message) => JSON.stringify(message.content).includes('Tauri stop smoke'))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: partial ? 'Partial Tauri reply' : 'Tauri mock reply' }, finish_reason: null }] })}\n\n`
      )
      if (partial) {
        responses.add(response)
        response.once('close', () => {
          stopped = true
          responses.delete(response)
        })
      } else response.end('data: [DONE]\n\n')
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
    const setup = await evaluate(`(async()=>{
      window.__EVOSTACK_SMOKE_DATA_TRACE__=[];
      const original=window.api.dataApi.request;
      window.api.dataApi.request=async(request)=>{const response=await original(request);if(['/assistants','/topics/reusable-placeholder'].includes(request.path))window.__EVOSTACK_SMOKE_DATA_TRACE__.push({request,response});return response};
      const data=async(method,path,body)=>{const r=await window.api.dataApi.request({method,path,body});if(r.error)throw Error(r.error.message);return r.data};
      const ipc=async(route,input)=>{const r=await window.api.ipcApi.request(route,input);if(!r.ok)throw Error(r.error?.message);return r.data};
      await window.api.preference.set('app.proxy.mode','none');
      await window.api.preference.set('topic.naming.enabled',false);
      await window.api.preference.set('app.computer_use.agent_control.enabled',false);
      const provider=await data('POST','/providers',{providerId:'evostack-ui-smoke',name:'Local UI smoke',endpointConfigs:{'openai-chat-completions':{baseUrl:${JSON.stringify(baseUrl)}}}});
      await data('PATCH','/providers/'+provider.id,{isEnabled:true});
      await data('POST','/providers/'+provider.id+'/api-keys',{key:'synthetic-ui-smoke-only'});
      const [model]=await data('POST','/models',[{providerId:provider.id,modelId:'local-ui-smoke'}]);
      await data('PATCH','/models/'+model.id,{isEnabled:true});
      const assistants=await data('GET','/assistants');
      if(assistants.items.length) await data('PATCH','/assistants/'+assistants.items[0].id,{modelId:model.id,name:'UI smoke assistant'});
      else await data('POST','/assistants',{name:'UI smoke assistant',modelId:model.id});
      const prompt=await data('POST','/prompts',{title:'UI smoke prompt',content:'Synthetic prompt fixture',visibility:'global'});
      if(!(await data('GET','/prompts')).some(item=>item.id===prompt.id))throw Error('Prompt persistence failed');
      const skills=await ipc('skill.list_catalog',{});if(!Array.isArray(skills)||!skills.length)throw Error('Skill catalog unavailable');
      const knowledge=await ipc('knowledge.create_base',{base:{name:'UI smoke knowledge'}});
      await ipc('knowledge.import_text',{baseId:knowledge.id,name:'fixture.txt',content:'TauriSmokeKnowledgeMarker'});
      const hits=await ipc('knowledge.search',{baseId:knowledge.id,query:'TauriSmokeKnowledgeMarker'});
      if(!hits.length)throw Error('Knowledge search failed');
      return {prompt:true,skills:true,knowledge:true};
    })()`)
    // Setup uses the raw host facade rather than React mutation hooks. Reload
    // this isolated window so its existing SWR queries read the seeded profile.
    await command('Page.reload', {})
    await until('Boolean(window.api?.ipcApi?.request && document.querySelector(\'[data-ui~="app.content"]\'))')
    const labels = localeCatalogs.map((locale) => locale['title.chat']).filter(Boolean)
    await evaluate(
      `(()=>{const labels=${JSON.stringify(labels)};const item=[...document.querySelectorAll('button')].find(node=>node.getBoundingClientRect().width>0&&labels.includes(node.textContent.trim()));if(!item)throw Error('Chat navigation missing');item.click()})()`
    )
    const addLabels = localeCatalogs.map((locale) => locale['chat.add.assistant.title']).filter(Boolean)
    await until(
      `Boolean([...document.querySelectorAll('button')].find(node=>node.getBoundingClientRect().width>0&&${JSON.stringify(addLabels)}.includes(node.textContent.trim())))`
    )
    await evaluate(
      `(()=>{const labels=${JSON.stringify(addLabels)};[...document.querySelectorAll('button')].find(node=>node.getBoundingClientRect().width>0&&labels.includes(node.textContent.trim())).click()})()`
    )
    await until(
      `Boolean([...document.querySelectorAll('[role="option"]')].find(node=>node.getBoundingClientRect().width>0&&node.textContent.includes('UI smoke assistant')))`
    )
    await evaluate(
      `[...document.querySelectorAll('[role="option"]')].find(node=>node.getBoundingClientRect().width>0&&node.textContent.includes('UI smoke assistant')).click()`
    )
    const submit = async (text) => {
      await until(
        `Boolean(document.querySelector('[data-composer-inputbar] textarea,[data-composer-inputbar] [contenteditable="true"]'))`
      )
      await evaluate(
        `(()=>{const input=document.querySelector('[data-composer-inputbar] [contenteditable="true"],[data-composer-inputbar] textarea');input.focus()})()`
      )
      await new Promise((done) => setTimeout(done, 400))
      await evaluate(
        `(()=>{const input=document.querySelector('[data-composer-inputbar] [contenteditable="true"],[data-composer-inputbar] textarea');input.focus()})()`
      )
      await command('Input.insertText', { text })
      await until(
        `Boolean([...document.querySelectorAll('[data-ui~="chat.composer.action.send"]')].find(node=>node.getBoundingClientRect().width>0&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'))`
      )
      await evaluate(
        `[...document.querySelectorAll('[data-ui~="chat.composer.action.send"]')].find(node=>node.getBoundingClientRect().width>0&&node.getAttribute('aria-disabled')!=='true').click()`
      )
    }
    await submit('Tauri mock chat smoke')
    await until(
      `document.body.textContent.includes('Tauri mock reply')&&!document.querySelector('[data-ui~="chat.composer.action.pause"]')`
    )
    assert.equal(streams, 1, 'Chat send must create one provider request')
    await submit('Tauri stop smoke')
    await until(
      `document.body.textContent.includes('Partial Tauri reply')&&Boolean(document.querySelector('[data-ui~="chat.composer.action.pause"]'))`
    )
    await evaluate(`document.querySelector('[data-ui~="chat.composer.action.pause"]').click()`)
    const deadline = Date.now() + 5000
    while (!stopped && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50))
    assert(stopped, 'Stop must close the owned provider stream')
    await until(
      `!document.querySelector('[data-ui~="chat.composer.action.pause"]')&&document.body.textContent.includes('Partial Tauri reply')`
    )
    assert.equal(streams, 2, 'Stopping must not replay the request')
    return { ...setup, chat: true, stop: true, noReplay: true }
  } finally {
    for (const response of responses) response.destroy()
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
}

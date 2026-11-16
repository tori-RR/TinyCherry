import assert from 'node:assert/strict'
import test from 'node:test'

import { JSDOM } from 'jsdom'

import { openChatPage } from '../../../native/evostack/verify-chat-page.mjs'

function page(html, onPending = () => {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' })
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.closest('[hidden]') ? { width: 0, height: 0 } : { width: 100, height: 30 }
  }
  const evaluate = async (expression) => dom.window.eval(expression)
  const until = async (expression) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const value = await evaluate(expression)
      if (value) return value
      onPending(dom.window.document)
      await new Promise((done) => setImmediate(done))
    }
    throw new Error('Chat page did not become ready')
  }
  return {
    dom,
    document: dom.window.document,
    evaluate,
    until,
    labels: ['Chat', '对话'],
    assistantLabels: ['Add Assistant', '添加助手']
  }
}

await test('an English chat page is ready without a visible sidebar navigation button', async () => {
  const fixture = page('<main><h1>Conversations</h1><button>Add Assistant</button></main>')
  try {
    let clicks = 0
    fixture.document.querySelector('button').addEventListener('click', () => clicks++)
    await openChatPage(fixture)
    assert.equal(clicks, 0)
  } finally {
    fixture.dom.window.close()
  }
})

await test('a hidden chat view does not replace navigation through an icon-only button', async () => {
  const fixture = page('<main hidden data-ui="chat.view"></main><button aria-label="Chat"><svg></svg></button>')
  try {
    let clicks = 0
    fixture.document.querySelector('button').addEventListener('click', () => {
      clicks++
      fixture.document.querySelector('main').hidden = false
    })
    await openChatPage(fixture)
    assert.equal(clicks, 1)
    assert.equal(fixture.document.querySelector('main').hidden, false)
  } finally {
    fixture.dom.window.close()
  }
})

await test('navigation waits for a lazily mounted localized sidebar', async () => {
  const fixture = page('<div>Loading</div>', (document) => {
    document.body.innerHTML = '<button>对话</button>'
    document.querySelector('button').addEventListener('click', () => {
      document.body.innerHTML = '<main data-ui="chat.view"></main>'
    })
  })
  try {
    await openChatPage(fixture)
    assert(fixture.document.querySelector('[data-ui~="chat.view"]'))
  } finally {
    fixture.dom.window.close()
  }
})

await test('missing chat content and unrelated buttons fail instead of skipping navigation', async () => {
  const fixture = page('<button hidden>Add Assistant</button><button>Delete</button>')
  try {
    let clicks = 0
    fixture.document.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => clicks++))
    await assert.rejects(openChatPage(fixture), /Chat page did not become ready/)
    assert.equal(clicks, 0)
  } finally {
    fixture.dom.window.close()
  }
})

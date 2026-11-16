/** The native workspace can already show chat while its sidebar is collapsed. */
export async function openChatPage({ evaluate, until, labels, assistantLabels = [] }) {
  const ready = `Boolean([...document.querySelectorAll('[data-ui~="chat.view"]')].some(node=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0})||[...document.querySelectorAll('button')].some(node=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0&&!node.disabled&&${JSON.stringify(assistantLabels)}.includes(node.textContent.trim())}))`
  const navigation = `[...document.querySelectorAll('button')].find(node=>{const box=node.getBoundingClientRect();return box.width>0&&box.height>0&&!node.disabled&&node.getAttribute('aria-disabled')!=='true'&&[node.textContent,node.getAttribute('aria-label'),node.getAttribute('title')].some(value=>${JSON.stringify(labels)}.includes(value?.trim()))})`
  const state = await until(`(${ready})?'ready':(${navigation})?'navigate':null`)
  if (state === 'navigate') {
    await evaluate(
      `(()=>{const item=${navigation};if(!item)throw Error('Chat navigation disappeared');item.click();return true})()`
    )
  }
  await until(ready)
}

import { dev } from '../../dev.mjs'
import { state } from './dev-adapter.mjs'

const deadline = setTimeout(() => {
  console.error('DEV_TEST_TIMEOUT')
  process.exit(91)
}, 10_000)
const messages = []
const signals = ['SIGINT', 'SIGTERM']
const listeners = signals.map((signal) => process.listenerCount(signal))
function record(error) {
  messages.push(error instanceof Error ? error.message : String(error))
  if (error instanceof AggregateError) for (const cause of error.errors) record(cause)
}
try {
  await dev()
} catch (error) {
  record(error)
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  const handlersReleased = signals.every((signal, index) => process.listenerCount(signal) === listeners[index])
  console.log(`DEV_TEST_RESULT ${JSON.stringify({ ...state(), messages, handlersReleased })}`)
}

import { parentPort } from 'node:worker_threads'
import { createRegistryWorker } from './windows-registry'
import { PublicError } from '../../shared/public-errors'

const port = parentPort
if (!port) throw new Error('Registry worker requires a parent port')
const worker = createRegistryWorker()
let draining = false
const operations = new Set<Promise<void>>()
port.on('message', (message: { kind: string; id?: number; payload?: object }) => {
  if (message.kind === 'close') {
    if (draining) return
    draining = true
    void Promise.allSettled([...operations]).then(() => worker.close()).finally(() => port.close())
    return
  }
  if (message.kind !== 'execute' || draining || typeof message.id !== 'number' || !message.payload) return
  const operation = worker.execute(message.payload).then(value => {
    port.postMessage({ kind: 'result', id: message.id, ok: true, value })
  }, error => {
    port.postMessage({ kind: 'result', id: message.id, ok: false, code: error instanceof PublicError ? error.code : 'OPERATION_FAILED' })
  })
  operations.add(operation)
  void operation.finally(() => operations.delete(operation))
})

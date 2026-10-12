import { withSettingsWriteLock } from '../../src/main/settings/settings-write-lock'

const [root, timeout] = process.argv.slice(2)
let release: () => void
const released = new Promise<void>((resolve) => { release = resolve })
process.on('message', (message) => { if (message === 'release') release() })
process.send!({ event: 'waiting' })
void withSettingsWriteLock(root!, async () => {
  process.send!({ event: 'acquired' })
  await released
  return 'completed'
}, Number(timeout)).then(
  (value) => process.send!({ event: 'finished', value }),
  (error: { code?: string }) => process.send!({ event: 'error', code: error.code }),
).finally(() => process.disconnect!())

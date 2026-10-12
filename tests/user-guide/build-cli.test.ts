import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

it('runs the user-guide builder through Node 24', async () => {
  const result = await execFileAsync(process.execPath, ['scripts/build-user-guide.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
    },
  })

  expect(result.stderr).toBe('')
}, 20_000)

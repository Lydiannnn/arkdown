import { expect, it } from 'vitest'

it.runIf(process.platform === 'win32')('classifies a real PowerShell identity timeout as unknown instead of stale', async () => {
  const { windowsProcessCreationIdentityMatches } = await import(
    '../../src/main/screenshot-translation/process-creation-identity'
  )
  await expect(windowsProcessCreationIdentityMatches(process.pid, 'win:1234567890', 1)).resolves.toBe('unknown')
})

it.runIf(process.platform === 'win32')('distinguishes a healthy identity query from an unknown query failure', async () => {
  const { windowsProcessCreationIdentityMatches } = await import(
    '../../src/main/screenshot-translation/process-creation-identity'
  )
  await expect(windowsProcessCreationIdentityMatches(process.pid, 'win:0')).resolves.toBe('dead-or-mismatch')
})

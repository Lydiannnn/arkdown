import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('wires the gated E2E persistence observer into the desktop lifecycle', async () => {
  const source = await readFile('src/main/arkdown-main.ts', 'utf8')

  expect(source).toContain('documentServiceOptions:')
  expect(source).toContain('onStage: createE2ePersistenceObserver(process.env)')
})

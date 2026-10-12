import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'

it('keeps default file parallelism and makes serial evidence explicit', async () => {
  const [config, packageJson] = await Promise.all([
    readFile(path.join(process.cwd(), 'vitest.config.ts'), 'utf8'),
    readFile(path.join(process.cwd(), 'package.json'), 'utf8').then((value) => JSON.parse(value) as { scripts: Record<string, string> }),
  ])
  expect(config).not.toContain("process.platform !== 'win32'")
  expect(config).toContain("process.env.ARKDOWN_SERIAL_TESTS !== '1'")
  expect(packageJson.scripts['test:parallel:sticky']).toContain('--maxWorkers=2')
  expect(packageJson.scripts['test:parallel:sticky']).toContain('--fileParallelism')
})

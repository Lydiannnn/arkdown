import { chromium, type Browser, type Page } from 'playwright'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1]
    ? path.resolve(process.argv[index + 1]!)
    : fallback
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Could not reserve a DevTools port.'))
        return
      }
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function connect(port: number): Promise<Browser> {
  const endpoint = `http://127.0.0.1:${port}`
  let lastError: unknown
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await chromium.connectOverCDP(endpoint, { timeout: 1_000 })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 125))
    }
  }
  throw lastError ?? new Error('Arkdown DevTools endpoint did not become available.')
}

async function mainPage(browser: Browser): Promise<Page> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (await page.locator('.sticky-note-box-toolbar-button').count()) return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 125))
  }
  throw new Error('Arkdown main page did not become available.')
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return
  await execFileAsync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true },
  ).catch(() => undefined)
}

const projectRoot = option('--project-root', path.resolve(import.meta.dirname, '..'))
const packageRoot = option('--package-root', path.join(projectRoot, 'out', 'Arkdown-win32-x64'))
const output = path.join(projectRoot, 'user-guide', 'assets', 'images', 'sticky-note-box.png')
const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-guide-sticky-'))
const applicationRoot = path.join(runtimeRoot, 'Arkdown')
const workspace = path.join(runtimeRoot, 'Arkdown 示例工作区')
let child: ChildProcess | undefined
let browser: Browser | undefined

try {
  await cp(packageRoot, applicationRoot, { recursive: true })
  await rm(path.join(applicationRoot, 'portable-data'), { force: true, recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(
    path.join(workspace, '便签功能示例.md'),
    '# 便签功能示例\n\n使用工具栏中的便签按钮整理临时想法。\n',
    'utf8',
  )
  await mkdir(path.dirname(output), { recursive: true })

  const port = await availablePort()
  child = spawn(path.join(applicationRoot, 'Arkdown.exe'), [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--disable-gpu',
    '--window-size=1360,900',
    `--user-data-dir=${path.join(runtimeRoot, 'user-data')}`,
  ], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      APPDATA: runtimeRoot,
      LOCALAPPDATA: runtimeRoot,
      ARKDOWN_E2E: '1',
      ARKDOWN_E2E_RECOVER: '1',
      ARKDOWN_E2E_WORKSPACE: workspace,
    },
    stdio: 'ignore',
    windowsHide: true,
  })

  browser = await connect(port)
  const page = await mainPage(browser)
  await page.bringToFront()
  await page.locator('.sticky-note-box-toolbar-button').click()
  const firstUse = page.locator('.sticky-note-first-use-dialog')
  if (await firstUse.isVisible().catch(() => false)) {
    await firstUse.getByRole('button', { name: '暂不开启' }).click()
  }
  await page.locator('.sticky-note-grid').waitFor({ state: 'visible' })
  await page.evaluate(async () => {
    const notes = [
      {
        name: '项目灵感',
        markdown: '# 项目灵感\n\n记录下一次迭代值得尝试的想法。',
        style: { mode: 'preset' as const, colorPresetId: 'blue' as const, texturePresetId: 'grid' as const },
      },
      {
        name: '今日待办',
        markdown: '# 今日待办\n\n- [ ] 整理资料\n- [ ] 完成复核',
        style: { mode: 'preset' as const, colorPresetId: 'green' as const, texturePresetId: 'ruled' as const },
      },
    ]
    for (const note of notes) {
      const result = await window.arkdown.createStickyNote(note)
      if (!result.ok) throw new Error(result.error.message)
    }
  })
  await page.locator('.sticky-note-card').nth(3).waitFor({ state: 'visible' })
  await page.screenshot({ animations: 'disabled', path: output })
} finally {
  await browser?.close().catch(() => undefined)
  await terminate(child)
  await rm(runtimeRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 })
}

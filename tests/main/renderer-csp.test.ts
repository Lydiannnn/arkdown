import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { transformRendererCsp } from '../../src/renderer/csp-policy'

it('keeps packaged renderer CSP free of development network permissions', async () => {
  const html = await readFile(resolve('src/renderer/index.html'), 'utf8')
  const production = transformRendererCsp(html, 'build')

  expect(production).toContain("connect-src 'self' arkdown-ocr:")
  expect(production).toContain("script-src 'self' arkdown-ocr:")
  expect(production).toContain("worker-src 'self'")
  expect(production).toContain("img-src 'self' data: arkdown-asset:")
  expect(production).toContain("media-src 'self' arkdown-asset:")
  expect(production).not.toContain('file:')
  expect(production).not.toMatch(/\bws:/)
  expect(production).not.toContain('http://127.0.0.1:*')
  expect(production).not.toContain('https:')
  expect(production).not.toContain('blob:')
  expect(production).not.toContain("'unsafe-eval'")
})

it('keeps Mermaid rendering within the existing self, data, and local-protocol CSP boundary', async () => {
  const html = await readFile(resolve('src/renderer/index.html'), 'utf8')
  const production = transformRendererCsp(html, 'build')

  expect(production).toContain("default-src 'self'")
  expect(production).toContain("script-src 'self' arkdown-ocr:")
  expect(production).toContain("worker-src 'self'")
  expect(production).toContain("img-src 'self' data: arkdown-asset:")
  expect(production).toContain("font-src 'self' data:")
  for (const forbidden of ['https:', 'blob:', 'file:', "'unsafe-eval'"]) {
    expect(production).not.toContain(forbidden)
  }
})

it('adds local HMR connection permissions only while serving development', async () => {
  const html = await readFile(resolve('src/renderer/index.html'), 'utf8')
  const development = transformRendererCsp(html, 'serve')

  expect(development).toContain("connect-src 'self' arkdown-ocr: ws: http://127.0.0.1:*")
})

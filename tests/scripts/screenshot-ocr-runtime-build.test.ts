// @vitest-environment node
import path from 'node:path'
import { build, defaultClientConditions, resolveConfig } from 'vite'
import { expect, it } from 'vitest'
import { screenshotOcrRuntimeBuildConfig } from '../../scripts/build-screenshot-ocr-runtime'
import { SCREENSHOT_OCR_RESOURCE_URLS } from '../../src/shared/screenshot-ocr-manifest'

const configFile = path.resolve('vite.renderer.config.ts')

it.each(['serve', 'build'] as const)('selects the supported external ORT runtime during %s without replacing browser conditions', async (command) => {
  const config = await resolveConfig({ configFile, logLevel: 'silent' }, command)
  expect(config.resolve.conditions).toEqual(expect.arrayContaining([
    ...defaultClientConditions,
    'onnxruntime-web-use-extern-wasm',
  ]))
  const resolved = await config.createResolver()('onnxruntime-web', path.resolve('src/renderer/screenshot/screenshot-ocr-worker.ts'))
  expect(resolved?.replaceAll('\\', '/')).toMatch(/\/onnxruntime-web\/dist\/ort\.min\.mjs$/u)
})

it('keeps the core worker bootstrap small with no SDK, OpenCV, or duplicate WASM', async () => {
  const workerModules: string[] = []
  const built = await build({
    configFile,
    logLevel: 'silent',
    worker: {
      plugins: () => [{
        name: 'inspect-ocr-runtime-resolution',
        moduleParsed(module) { workerModules.push(module.id.replaceAll('\\', '/')) },
      }],
    },
    build: {
      write: false,
      lib: {
        entry: path.resolve('src/renderer/screenshot/screenshot-ocr-client.ts'),
        formats: ['es'],
        fileName: 'screenshot-ocr-client',
      },
    },
  })
  if ('on' in built) throw new Error('Unexpected watch build')
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output)
  expect(outputs.some(({ fileName }) => fileName.endsWith('.wasm'))).toBe(false)
  expect(workerModules.some((id) => /paddleocr|opencv|onnxruntime-web/u.test(id))).toBe(false)
  expect(workerModules.some((id) => id.endsWith('/onnxruntime-web/dist/ort.bundle.min.mjs'))).toBe(false)
  const worker = outputs.find(({ fileName }) => /screenshot-ocr-bootstrap-worker-.*\.js$/u.test(fileName))
  expect(worker).toBeDefined()
  const code = worker?.type === 'asset' ? worker.source.toString() : worker?.code
  expect(code).toContain(SCREENSHOT_OCR_RESOURCE_URLS.ortPrefix.split('://')[0])
  expect(code).toContain('worker.js')
  expect(code!.length).toBeLessThan(20_000)
}, 30_000)

it('builds the standalone component as one worker with external verified ORT resources', async () => {
  const built = await build({ ...screenshotOcrRuntimeBuildConfig(path.resolve('.components/ocr-base/runtime')), logLevel: 'silent', build: {
    ...screenshotOcrRuntimeBuildConfig(path.resolve('.components/ocr-base/runtime')).build, write: false,
  } })
  if ('on' in built) throw new Error('Unexpected watch build')
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => result.output)
  expect(outputs.map(({ fileName }) => fileName)).toEqual(['worker.js'])
  const worker = outputs[0]!
  expect(worker.type).toBe('chunk')
  if (worker.type !== 'chunk') throw new Error('Expected worker module')
  expect(Object.keys(worker.modules).some((id) => id.replaceAll('\\', '/').endsWith('/onnxruntime-web/dist/ort.min.mjs'))).toBe(true)
  expect(Object.keys(worker.modules).some((id) => id.includes('opencv-js'))).toBe(true)
  expect(worker.code).toContain('ort-wasm-simd-threaded.jsep.mjs')
  expect(worker.code).toContain('arkdown-ocr')
  expect(worker.imports).toEqual([])
}, 30_000)

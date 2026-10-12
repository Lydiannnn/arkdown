import { describe, expect, it, vi } from 'vitest'

import {
  createMermaidRenderService,
  getWindowMermaidRenderService,
} from '../../src/renderer/editor/mermaid/mermaid-render-service'
import type { MermaidAppearance, MermaidRenderRequest } from '../../src/renderer/editor/mermaid/mermaid-types'

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0L2 2"/></svg>'

const lightAppearance: MermaidAppearance = {
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: 'Inter, sans-serif',
}

function request(source: string, appearance: MermaidAppearance = lightAppearance): MermaidRenderRequest {
  return {
    instanceId: 'diagram-1',
    generation: 1,
    source,
    appearance: { ...appearance },
    signal: new AbortController().signal,
  }
}

function makeFake() {
  return {
    initialize: vi.fn((_config: Record<string, unknown>) => undefined),
    parse: vi.fn(async (_source: string, _options: { suppressErrors: true }) => ({ diagramType: 'flowchart-v2' })),
    render: vi.fn(async (_id: string, _source: string) => ({ svg: safeSvg, bindFunctions: vi.fn() })),
  }
}

describe('createMermaidRenderService', () => {
  it('returns one shared service to independent consumers in the renderer window', () => {
    const firstConsumer = getWindowMermaidRenderService()
    const secondConsumer = getWindowMermaidRenderService()

    expect(secondConsumer).toBe(firstConsumer)
  })

  it('does not load Mermaid before the first valid render request', async () => {
    const fake = makeFake()
    const loadMermaid = vi.fn(async () => fake)
    const service = createMermaidRenderService({ loadMermaid })

    expect(loadMermaid).not.toHaveBeenCalled()
    await service.render(request('flowchart LR\nA-->B'))
    expect(loadMermaid).toHaveBeenCalledOnce()
  })

  it('clears only the rejected loader promise so a later request can retry', async () => {
    const fake = makeFake()
    const loadMermaid = vi.fn<() => Promise<typeof fake>>()
      .mockRejectedValueOnce(new Error('transient chunk failure'))
      .mockResolvedValueOnce(fake)
    const service = createMermaidRenderService({ loadMermaid })

    await expect(service.render(request('first'))).resolves.toEqual({
      status: 'syntax-error',
      message: 'Mermaid 语法错误',
      summary: { kind: 'generic' },
    })
    await expect(service.render(request('second'))).resolves.toMatchObject({ status: 'ready' })
    expect(loadMermaid).toHaveBeenCalledTimes(2)
  })

  it('snapshots source and appearance before the SHA-256 await boundary', async () => {
    const fake = makeFake()
    const service = createMermaidRenderService({ loadMermaid: async () => fake })
    const mutableRequest = request('original')

    const pending = service.render(mutableRequest)
    mutableRequest.source = 'x'.repeat(20_001)
    mutableRequest.appearance.themeColor = '#ff0000'
    mutableRequest.appearance.bodyFontFamily = 'Mutated Font'

    await expect(pending).resolves.toMatchObject({ status: 'ready' })
    await service.render(request('original'))
    expect(fake.parse).toHaveBeenCalledOnce()
    expect(fake.parse).toHaveBeenCalledWith('original', { suppressErrors: true })
    expect(fake.initialize).toHaveBeenCalledWith(expect.objectContaining({
      fontFamily: 'Inter, sans-serif',
      themeVariables: expect.objectContaining({ primaryColor: '#336699' }),
    }))
  })

  it('rejects 20,001 UTF-16 code units before loading but lets exactly 20,000 reach parse', async () => {
    const fake = makeFake()
    const loadMermaid = vi.fn(async () => fake)
    const service = createMermaidRenderService({ loadMermaid })

    await expect(service.render(request('x'.repeat(20_001)))).resolves.toEqual({
      status: 'resource-error',
      code: 'SOURCE_LIMIT',
      message: 'Mermaid 源码超过 20,000 字符限制',
    })
    expect(loadMermaid).not.toHaveBeenCalled()

    await service.render(request('x'.repeat(20_000)))
    expect(fake.parse).toHaveBeenCalledWith('x'.repeat(20_000), { suppressErrors: true })
  })

  it('passes only the app-owned strict configuration and appearance snapshot', async () => {
    const fake = makeFake()
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    await service.render(request('flowchart LR\nA-->B'))

    expect(fake.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      maxTextSize: 20_000,
      maxEdges: 100,
      look: 'classic',
      theme: 'base',
      fontFamily: 'Inter, sans-serif',
      themeVariables: expect.objectContaining({
        fontFamily: 'Inter, sans-serif',
        primaryColor: '#336699',
      }),
      secure: expect.arrayContaining([
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'htmlLabels',
        'fontFamily',
        'altFontFamily',
        'themeCSS',
        'themeVariables',
        'look',
        'theme',
      ]),
    }))
  })

  it('runs initialize, parse, and render for different jobs in FIFO order without overlap', async () => {
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const fake = {
      initialize: vi.fn(() => { events.push('initialize') }),
      parse: vi.fn(async (source: string) => { events.push(`parse:${source}`) }),
      render: vi.fn(async (_id: string, source: string) => {
        events.push(`render-start:${source}`)
        if (source === 'first') await firstGate
        events.push(`render-end:${source}`)
        return { svg: safeSvg }
      }),
    }
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const first = service.render(request('first'))
    const second = service.render(request('second'))
    await vi.waitFor(() => expect(events).toContain('render-start:first'))
    expect(events).not.toContain('parse:second')
    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual([
      'initialize', 'parse:first', 'render-start:first', 'render-end:first',
      'initialize', 'parse:second', 'render-start:second', 'render-end:second',
    ])
  })

  it('preserves call order across an out-of-order asynchronous cache-key boundary', async () => {
    let releaseFirstHash!: (value: string) => void
    const firstHash = new Promise<string>((resolve) => { releaseFirstHash = resolve })
    const hash = vi.fn((material: string) => (
      material.includes('"first"') ? firstHash : Promise.resolve('second-key')
    ))
    const fake = makeFake()
    const service = createMermaidRenderService({ loadMermaid: async () => fake, hash })

    const first = service.render(request('first'))
    const second = service.render(request('second'))
    await Promise.resolve()
    await Promise.resolve()
    expect(hash).toHaveBeenCalledOnce()

    releaseFirstHash('first-key')
    await Promise.all([first, second])

    expect(hash).toHaveBeenCalledTimes(2)
    expect(fake.render.mock.calls.map((call) => call[1])).toEqual(['first', 'second'])
  })

  it('continues admission after a cache-key failure without consuming queue capacity', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const hash = vi.fn()
      .mockRejectedValueOnce(new Error('hash failed'))
      .mockImplementation(async (material: string) => material)
    const fake = makeFake()
    fake.render.mockImplementation(async () => {
      await gate
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake, hash })

    await expect(service.render(request('first'))).rejects.toThrow('hash failed')
    const jobs = Array.from({ length: 11 }, (_, index) => (
      service.render(request(`recovered-${index}`))
    ))
    await expect(jobs[10]).resolves.toEqual({
      status: 'resource-error',
      code: 'QUEUE_LIMIT',
      message: 'Mermaid 图形生成队列已满',
    })
    release()
    const accepted = await Promise.all(jobs.slice(0, 10))

    expect(accepted).toHaveLength(10)
    expect(accepted.every((result) => result.status === 'ready')).toBe(true)
    expect(hash).toHaveBeenCalledTimes(12)
    expect(fake.render).toHaveBeenCalledTimes(10)
  })

  it('continues the FIFO after a Mermaid job rejects', async () => {
    const fake = makeFake()
    fake.render
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ svg: safeSvg, bindFunctions: vi.fn() })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const [first, second] = await Promise.all([
      service.render(request('first')),
      service.render(request('second')),
    ])

    expect(first.status).not.toBe('ready')
    expect(second.status).toBe('ready')
    expect(fake.render).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent requests with the same source and complete appearance key', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = makeFake()
    fake.render.mockImplementation(async () => {
      await gate
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const first = service.render(request('same'))
    const second = service.render({ ...request('same'), instanceId: 'diagram-2', generation: 9 })
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalledOnce())
    release()

    expect(await first).toEqual(await second)
    expect(fake.render).toHaveBeenCalledOnce()
  })

  it('keeps a coalesced job alive when its first caller aborts but another caller remains active', async () => {
    let releaseLoader!: () => void
    const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve })
    const fake = makeFake()
    const loadMermaid = vi.fn(async () => {
      await loaderGate
      return fake
    })
    const hash = vi.fn(async () => 'shared-key')
    const service = createMermaidRenderService({ loadMermaid, hash })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstRequest = request('same')
    const secondRequest = { ...request('same'), instanceId: 'diagram-2', signal: secondController.signal }
    firstRequest.signal = firstController.signal
    const firstRemove = vi.spyOn(firstController.signal, 'removeEventListener')
    const secondRemove = vi.spyOn(secondController.signal, 'removeEventListener')

    const first = service.render(firstRequest)
    const second = service.render(secondRequest)
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(loadMermaid).toHaveBeenCalledOnce())

    firstController.abort()
    releaseLoader()

    await expect(first).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    await expect(second).resolves.toMatchObject({ status: 'ready' })
    expect(fake.render).toHaveBeenCalledOnce()
    expect(firstRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(secondRemove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('skips one coalesced queued job after all of its callers abort', async () => {
    let releaseActive!: () => void
    const activeGate = new Promise<void>((resolve) => { releaseActive = resolve })
    const fake = makeFake()
    fake.render.mockImplementation(async (_id: string, source: string) => {
      if (source === 'active') await activeGate
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const hash = vi.fn(async (material: string) => material)
    const service = createMermaidRenderService({ loadMermaid: async () => fake, hash })
    const active = service.render(request('active'))
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalledOnce())

    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstRequest = request('same')
    const secondRequest = { ...request('same'), instanceId: 'diagram-2', signal: secondController.signal }
    firstRequest.signal = firstController.signal
    const first = service.render(firstRequest)
    const second = service.render(secondRequest)
    await vi.waitFor(() => expect(hash).toHaveBeenCalledTimes(3))

    firstController.abort()
    secondController.abort()
    releaseActive()

    await expect(active).resolves.toMatchObject({ status: 'ready' })
    await expect(first).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    await expect(second).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    expect(fake.render.mock.calls.map((call) => call[1])).toEqual(['active'])
  })

  it('does not cache an active render after all of its coalesced callers abort', async () => {
    let releaseFirstRender!: () => void
    const firstRenderGate = new Promise<void>((resolve) => { releaseFirstRender = resolve })
    let firstSameRender = true
    const fake = makeFake()
    fake.render.mockImplementation(async (_id: string, source: string) => {
      if (source === 'same' && firstSameRender) {
        firstSameRender = false
        await firstRenderGate
      }
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstRequest = request('same')
    const secondRequest = { ...request('same'), instanceId: 'diagram-2', signal: secondController.signal }
    firstRequest.signal = firstController.signal

    const first = service.render(firstRequest)
    const second = service.render(secondRequest)
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalledOnce())
    firstController.abort()
    secondController.abort()

    await expect(first).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    await expect(second).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    releaseFirstRender()
    await expect(service.render(request('barrier'))).resolves.toMatchObject({ status: 'ready' })
    await expect(service.render(request('same'))).resolves.toMatchObject({ status: 'ready' })

    expect(fake.render.mock.calls.map((call) => call[1])).toEqual(['same', 'barrier', 'same'])
  })

  it('misses cache when source or any appearance field changes', async () => {
    const fake = makeFake()
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    await service.render(request('A'))
    await service.render(request('B'))
    await service.render(request('A', { ...lightAppearance, revision: 2 }))
    await service.render(request('A', { ...lightAppearance, colorScheme: 'dark' }))
    await service.render(request('A'))

    expect(fake.render).toHaveBeenCalledTimes(4)
  })

  it('evicts the least recently used entry after the 32-entry cache limit', async () => {
    const fake = makeFake()
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    for (let index = 0; index < 32; index += 1) await service.render(request(`source-${index}`))
    await service.render(request('source-0'))
    await service.render(request('source-32'))
    await service.render(request('source-1'))

    expect(fake.render).toHaveBeenCalledTimes(34)
  })

  it('evicts by the 8 MiB UTF-16 data-URL budget before the entry-count limit', async () => {
    const fake = makeFake()
    const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'a'.repeat(1_100_000)}</text></svg>`
    fake.render.mockResolvedValue({ svg: largeSvg, bindFunctions: vi.fn() })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    await service.render(request('large-a'))
    await service.render(request('large-b'))
    await service.render(request('large-a'))
    await service.render(request('large-c'))
    await service.render(request('large-b'))

    expect(fake.render).toHaveBeenCalledTimes(4)
  })

  it('never invokes bindFunctions and returns only a sanitized base64 data image', async () => {
    const bindFunctions = vi.fn()
    const fake = makeFake()
    fake.render.mockResolvedValue({ svg: safeSvg, bindFunctions })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const result = await service.render(request('flowchart LR\nA-->B'))

    expect(bindFunctions).not.toHaveBeenCalled()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Expected ready result')
    expect(result.dataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(result.dataUrl.split(',')[1]!), (char) => char.charCodeAt(0)),
    )
    expect(decoded).toContain('<path')
    expect(decoded).not.toContain('<script')
  })

  it('returns a generic bounded error without stack text or user source', async () => {
    const secretSource = 'flowchart LR\nprivate_customer_name-->B'
    const fake = makeFake()
    const error = new Error(`Parse failed for ${secretSource}`)
    error.stack = `Error: ${error.message}\n    at C:\\private\\module.js:1:1`
    fake.parse.mockRejectedValue(error)
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const result = await service.render(request(secretSource))

    expect(result).toEqual({
      status: 'syntax-error',
      message: 'Mermaid 语法错误',
      summary: { kind: 'generic' },
    })
    expect(JSON.stringify(result)).not.toContain('private_customer_name')
    expect(JSON.stringify(result)).not.toContain('module.js')
  })

  it('reduces hostile parser details to an allowlisted line summary without copying raw text', async () => {
    const secretSource = 'flowchart LR\nprivate_customer_name-->'
    const fake = makeFake()
    const error = new Error([
      'Parse error on line 2:',
      secretSource,
      '<img src=x onerror=alert(1)>',
      'C:\\private\\module.js',
      'x'.repeat(600),
    ].join('\n'))
    error.stack = `Error: ${error.message}\n    at C:\\private\\module.js:1:1`
    fake.parse.mockRejectedValue(error)
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const result = await service.render(request(secretSource))
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      status: 'syntax-error',
      message: 'Mermaid 语法错误',
      summary: { kind: 'line', line: 2 },
    })
    expect(serialized).not.toContain('private_customer_name')
    expect(serialized).not.toContain('module.js')
    expect(serialized).not.toContain('<img')
    expect(serialized).not.toContain('x'.repeat(500))
  })

  it.each([
    [
      'No diagram type detected matching given configuration for text: private_customer_name',
      { kind: 'unknown-diagram' },
    ],
    [
      'Unexpected parser failure for private_customer_name at C:\\private\\module.js',
      { kind: 'generic' },
    ],
  ])('normalizes a syntax failure without echoing its message: %s', async (internalMessage, summary) => {
    const fake = makeFake()
    fake.parse.mockRejectedValue(new Error(internalMessage))
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const result = await service.render(request('flowchart LR\nprivate_customer_name-->'))

    expect(result).toEqual({
      status: 'syntax-error',
      message: 'Mermaid 语法错误',
      summary,
    })
    expect(JSON.stringify(result)).not.toContain('private_customer_name')
    expect(JSON.stringify(result)).not.toContain('module.js')
  })

  it('marks a late non-preempted result TIMEOUT and then runs the next queued job', async () => {
    let clock = 0
    const fake = makeFake()
    fake.render.mockImplementation(async (_id: string, source: string) => {
      if (source === 'slow') clock = 2_501
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake, now: () => clock })

    const [slow, next] = await Promise.all([
      service.render(request('slow')),
      service.render(request('next')),
    ])

    expect(slow).toEqual({
      status: 'resource-error',
      code: 'TIMEOUT',
      message: 'Mermaid 图形生成超时',
    })
    expect(next.status).toBe('ready')
    expect(fake.render.mock.calls.map((call) => call[1])).toEqual(['slow', 'next'])
  })

  it('skips an aborted queued request when the active FIFO job releases', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = makeFake()
    fake.render.mockImplementation(async (_id: string, source: string) => {
      if (source === 'active') await gate
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })
    const active = service.render(request('active'))
    const controller = new AbortController()
    const queuedRequest = request('aborted')
    queuedRequest.signal = controller.signal
    const queued = service.render(queuedRequest)

    controller.abort()
    release()

    await expect(active).resolves.toMatchObject({ status: 'ready' })
    await expect(queued).resolves.toMatchObject({ status: 'resource-error', code: 'TIMEOUT' })
    expect(fake.render.mock.calls.map((call) => call[1])).toEqual(['active'])
  })

  it('rejects the eleventh distinct outstanding job at the explicit queue cap', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fake = makeFake()
    fake.render.mockImplementation(async () => {
      await gate
      return { svg: safeSvg, bindFunctions: vi.fn() }
    })
    const service = createMermaidRenderService({ loadMermaid: async () => fake })

    const jobs = Array.from({ length: 11 }, (_, index) => service.render(request(`queued-${index}`)))
    await expect(jobs[10]).resolves.toEqual({
      status: 'resource-error',
      code: 'QUEUE_LIMIT',
      message: 'Mermaid 图形生成队列已满',
    })
    release()
    await Promise.all(jobs.slice(0, 10))
  })
})

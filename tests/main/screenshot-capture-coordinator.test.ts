import { expect, it, vi, type Mock } from 'vitest'
import {
  createScreenshotCaptureCoordinator,
  type OverlayWindowLike,
  type ScreenshotCaptureCoordinatorDependencies,
} from '../../src/main/screenshot-translation/screenshot-capture-coordinator'
import { DisplayCaptureError, type CapturedDisplay, type NativeImageLike } from '../../src/main/screenshot-translation/display-capture'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const secondSessionId = '223e4567-e89b-42d3-a456-426614174000'
const safeWindowHit = () => ({ hwnd: '9007199254740993', processId: 42, processCreationIdentity: '132000000000000000', boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
const display: CapturedDisplay = {
  snapshot: {
    displayId: '1', boundsDip: { x: 0, y: 0, width: 100, height: 80 }, scaleFactor: 1,
    imageSizePx: { width: 100, height: 80 }, dataUrl: 'data:image/png;base64,AAAA',
  },
  image: {} as NativeImageLike,
}
const secondDisplay: CapturedDisplay = {
  ...display,
  snapshot: { ...display.snapshot, displayId: '2', boundsDip: { x: 0, y: 80, width: 100, height: 80 } },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function validCrop(): NativeImageLike {
  return {
    getSize: () => ({ width: 10, height: 10 }),
    toDataURL: () => 'data:image/png;base64,AAAA',
    isEmpty: () => false,
    toBitmap: () => Buffer.alloc(400, 255),
    crop: vi.fn(),
  }
}

interface TestOverlay extends OverlayWindowLike {
  emit(event: 'ready-to-show' | 'enter-full-screen' | 'closed' | 'blur'): void
  listenerCount(event: 'ready-to-show' | 'enter-full-screen' | 'closed' | 'blur'): number
  setFocused(value: boolean): void
  webContents: OverlayWindowLike['webContents'] & { send: Mock<(channel: string, value: unknown) => void> }
  setBounds: Mock<(bounds: { x: number; y: number; width: number; height: number }, animate?: boolean) => void>
  setFullScreen: Mock<(value: boolean) => void>
  getContentBounds: Mock<() => { x: number; y: number; width: number; height: number }>
  show: Mock<() => void>
  showInactive: Mock<() => void>
  focus: Mock<() => void>
  destroy: Mock<() => void>
}

function makeOverlay(): TestOverlay {
  const listeners = new Map<string, (() => void)[]>()
  let focused = false
  let destroyed = false
  const overlay: TestOverlay = {
    getNativeWindowHandle: () => Buffer.from('6400000000000000', 'hex'),
    webContents: { send: vi.fn<(channel: string, value: unknown) => void>(), isDestroyed: () => destroyed },
    on: vi.fn((event: string, listener: () => void) => {
      const current = listeners.get(event) ?? []
      current.push(listener)
      listeners.set(event, current)
    }) as TestOverlay['on'],
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    setBounds: vi.fn<(bounds: { x: number; y: number; width: number; height: number }, animate?: boolean) => void>(),
    setFullScreen: vi.fn<(value: boolean) => void>(),
    getContentBounds: vi.fn(() => ({ ...display.snapshot.boundsDip })),
    show: vi.fn<() => void>(),
    showInactive: vi.fn<() => void>(),
    focus: vi.fn<() => void>(() => { focused = true }),
    destroy: vi.fn<() => void>(() => { destroyed = true; for (const listener of listeners.get('closed') ?? []) listener() }),
    emit(event) { for (const listener of listeners.get(event) ?? []) listener() },
    removeListener(event, listener) {
      const current = listeners.get(event) ?? []
      listeners.set(event, current.filter((candidate) => candidate !== listener))
    },
    listenerCount(event) { return listeners.get(event)?.length ?? 0 },
    setFocused(value) { focused = value },
  }
  return overlay
}

function makeDependencies(overrides: Partial<ScreenshotCaptureCoordinatorDependencies> = {}) {
  const overlays: TestOverlay[] = []
  const registrations: Array<{ dispose: ReturnType<typeof vi.fn> }> = []
  const overlayOperations: Array<{
    updatePointer(input: unknown): Promise<unknown>
    commit(input: unknown): Promise<void>
    cancel(input?: unknown): Promise<void>
    ready(input: unknown): Promise<void>
  }> = []
  const deps: ScreenshotCaptureCoordinatorDependencies = {
    capture: { captureAll: vi.fn().mockResolvedValue([display]), crop: vi.fn(() => validCrop()) },
    hitTest: { hitTest: vi.fn().mockResolvedValue(null), dispose: vi.fn() },
    createWindow: vi.fn((input: { sessionId: string; display: CapturedDisplay['snapshot'] }) => {
      const overlay = makeOverlay()
      overlay.getContentBounds.mockReturnValue({ ...input.display.boundsDip })
      overlays.push(overlay)
      return overlay
    }),
    screen: { dipToScreenPoint: (point) => point, screenToDipRect: (_display, rect) => rect },
    createSessionId: () => sessionId,
    excludedWindowHandles: () => new Set(['42']),
    onCaptured: vi.fn(),
    onDeliveryFailed: vi.fn(),
    onCaptureFailed: vi.fn(),
    registerOverlay: vi.fn((_window, _displayId, operations) => {
      overlayOperations.push(operations as unknown as typeof overlayOperations[number])
      const registration = { dispose: vi.fn() }
      registrations.push(registration)
      return registration
    }),
    ...overrides,
  }
  return { deps, overlays, registrations, overlayOperations }
}

it('allows a same-process user window and excludes only exact auxiliary/overlay HWNDs', async () => {
  const hitTest = vi.fn().mockResolvedValue(safeWindowHit())
  const { deps } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await expect(coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } }))
    .resolves.toEqual({ processId: 42, rectDip: { x: 5, y: 5, width: 20, height: 20 } })
  expect(hitTest).toHaveBeenCalledWith({ x: 10, y: 10 }, new Set(['42', '100']))
  await coordinator.commit({ sessionId, displayId: '1', kind: 'window', processId: 42, rectDip: { x: 5, y: 5, width: 20, height: 20 } })
  expect(hitTest).toHaveBeenCalledTimes(2)
  expect(deps.onCaptured).toHaveBeenCalledOnce()
  await coordinator.dispose()
})

it.each([
  ['destroyed/ineligible', null],
  ['different HWND', { ...safeWindowHit(), hwnd: '999' }],
  ['different PID', { ...safeWindowHit(), processId: 99 }],
  ['reused PID creation identity', { ...safeWindowHit(), processCreationIdentity: '132000000000000001' }],
  ['moved/resized', { ...safeWindowHit(), boundsPx: { x: 6, y: 5, width: 20, height: 20 } }],
] as const)('rejects %s at commit and allows another pointer/commit attempt', async (_reason, changed) => {
  const hitTest = vi.fn().mockResolvedValueOnce(safeWindowHit()).mockResolvedValueOnce(changed).mockResolvedValue(safeWindowHit())
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  const selection = { sessionId, displayId: '1', kind: 'window' as const, processId: 42, rectDip: { x: 5, y: 5, width: 20, height: 20 } }
  await expect(coordinator.commit(selection)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(deps.capture.crop).not.toHaveBeenCalled()
  expect(overlays[0].destroy).not.toHaveBeenCalled()
  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith('screenshot-translation:capture-event', { sessionId, type: 'window-highlight', displayId: '1', hit: null })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.commit(selection)
  expect(deps.onCaptured).toHaveBeenCalledOnce()
  await coordinator.dispose()
})

it('does not crop or deliver after cancellation while commit revalidation is pending', async () => {
  const validation = deferred<ReturnType<typeof safeWindowHit> | null>()
  const hitTest = vi.fn().mockResolvedValueOnce(safeWindowHit()).mockReturnValueOnce(validation.promise)
  const { deps } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  const committing = coordinator.commit({ sessionId, displayId: '1', kind: 'window', processId: 42, rectDip: { x: 5, y: 5, width: 20, height: 20 } })
  await coordinator.cancel({ sessionId })
  validation.resolve(safeWindowHit())
  await expect(committing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(deps.capture.crop).not.toHaveBeenCalled()
  expect(deps.onCaptured).not.toHaveBeenCalled()
  await coordinator.dispose()
})

it('binds each overlay registration to its trusted display for pointer probes and commits', async () => {
  const { deps, overlayOperations } = makeDependencies({
    capture: { captureAll: vi.fn().mockResolvedValue([display, secondDisplay]), crop: vi.fn(() => validCrop()) },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await expect(overlayOperations[0]!.updatePointer({
    sessionId, displayId: '2', screenPointDip: { x: 10, y: 90 },
  })).resolves.toBeNull()
  expect(deps.hitTest.hitTest).not.toHaveBeenCalled()
  await overlayOperations[0]!.commit({
    sessionId, displayId: '2', kind: 'region', rectDip: { x: 0, y: 80, width: 10, height: 10 },
  })
  expect(deps.capture.crop).not.toHaveBeenCalled()
  expect(deps.onCaptured).not.toHaveBeenCalled()
})

it('shows only after exact fullscreen bounds and the matching renderer paint acknowledgement', async () => {
  const { deps, overlays, overlayOperations } = makeDependencies()
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  overlays[0]!.emit('ready-to-show')
  expect(overlays[0]!.webContents.send).toHaveBeenCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'selection-ready', display: display.snapshot },
  )
  expect(overlays[0]!.showInactive).not.toHaveBeenCalled()
  await overlayOperations[0]!.ready({ sessionId, displayId: '2' })
  expect(overlays[0]!.showInactive).not.toHaveBeenCalled()
  await overlayOperations[0]!.ready({ sessionId, displayId: '1' })
  expect(overlays[0]!.showInactive).toHaveBeenCalledOnce()
})

it('fails a missing renderer acknowledgement exactly once and recovers on the next begin', async () => {
  vi.useFakeTimers()
  try {
    const onCaptureFailed = vi.fn()
    const ids = [sessionId, secondSessionId]
    const { deps, overlays } = makeDependencies({
      createSessionId: () => ids.shift()!,
      onCaptureFailed,
    })
    const coordinator = createScreenshotCaptureCoordinator(deps)
    await coordinator.begin({ name: 'owner' })
    overlays[0]!.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(onCaptureFailed).toHaveBeenCalledOnce()
    expect(onCaptureFailed).toHaveBeenCalledWith({ name: 'owner' }, 'CAPTURE_UNAVAILABLE')
    expect(overlays[0]!.destroy).toHaveBeenCalledOnce()
    await expect(coordinator.begin()).resolves.toBe(secondSessionId)
  } finally {
    vi.useRealTimers()
  }
})

it('fails exactly once when ready-to-show never arrives', async () => {
  vi.useFakeTimers()
  try {
    const onCaptureFailed = vi.fn()
    const { deps, overlays } = makeDependencies({ onCaptureFailed })
    const coordinator = createScreenshotCaptureCoordinator(deps)
    await coordinator.begin({ name: 'owner' })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(overlays[0]!.webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'failed', code: 'CAPTURE_UNAVAILABLE' },
    )
    expect(overlays[0]!.destroy).toHaveBeenCalledOnce()
    expect(onCaptureFailed).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('gives load, fullscreen bounds, and renderer decode independent bounded deadlines', async () => {
  vi.useFakeTimers()
  try {
    const workArea = { x: 0, y: 0, width: 100, height: 72 }
    const { deps, overlays, overlayOperations } = makeDependencies()
    const coordinator = createScreenshotCaptureCoordinator(deps)
    await coordinator.begin({ name: 'owner' })
    overlays[0]!.getContentBounds.mockReturnValue(workArea)

    await vi.advanceTimersByTimeAsync(450)
    overlays[0]!.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(75)
    overlays[0]!.getContentBounds.mockReturnValue(display.snapshot.boundsDip)
    overlays[0]!.emit('enter-full-screen')
    await overlayOperations[0]!.ready({ sessionId, displayId: '1' })

    expect(overlays[0]!.showInactive).toHaveBeenCalledOnce()
    expect(overlays[0]!.destroy).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('allows healthy cold load and image decode while retaining a separate short bounds deadline', async () => {
  vi.useFakeTimers()
  try {
    const { deps, overlays, overlayOperations } = makeDependencies()
    const coordinator = createScreenshotCaptureCoordinator(deps)
    await coordinator.begin()

    await vi.advanceTimersByTimeAsync(1_500)
    expect(overlays[0]!.destroy).not.toHaveBeenCalled()
    overlays[0]!.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(overlays[0]!.destroy).not.toHaveBeenCalled()
    await overlayOperations[0]!.ready({ sessionId, displayId: '1' })
    expect(overlays[0]!.showInactive).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('tears down exactly once when the overlay cannot receive its snapshot', async () => {
  const onCaptureFailed = vi.fn()
  const { deps, overlays } = makeDependencies({ onCaptureFailed })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin({ name: 'owner' })
  overlays[0]!.webContents.send.mockImplementationOnce(() => { throw new Error('window unavailable') })

  expect(() => overlays[0]!.emit('ready-to-show')).not.toThrow()
  await vi.waitFor(() => expect(onCaptureFailed).toHaveBeenCalledOnce())
  expect(overlays[0]!.destroy).toHaveBeenCalledOnce()
})

it('tears down exactly once when a ready overlay throws while showing', async () => {
  const onCaptureFailed = vi.fn()
  const { deps, overlays, overlayOperations } = makeDependencies({ onCaptureFailed })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin({ name: 'owner' })
  overlays[0]!.showInactive.mockImplementationOnce(() => { throw new Error('window unavailable') })
  overlays[0]!.emit('ready-to-show')

  await expect(overlayOperations[0]!.ready({ sessionId, displayId: '1' })).resolves.toBeUndefined()
  await vi.waitFor(() => expect(onCaptureFailed).toHaveBeenCalledOnce())
  expect(overlays[0]!.destroy).toHaveBeenCalledOnce()
})

it('captures all snapshots before creating overlays and delivers a clipped region once', async () => {
  let captureFinished = false
  const captureAll = vi.fn(async () => { captureFinished = true; return [display] })
  const { deps } = makeDependencies({ capture: { captureAll, crop: vi.fn(() => validCrop()) } })
  const createWindow = vi.fn(() => {
    expect(captureFinished).toBe(true)
    return makeOverlay()
  })
  deps.createWindow = createWindow
  const coordinator = createScreenshotCaptureCoordinator(deps)

  await expect(coordinator.begin()).resolves.toBe(sessionId)
  await coordinator.commit({ sessionId, displayId: '1', kind: 'region', rectDip: { x: -10, y: 1, width: 20, height: 10 } })

  expect(deps.capture.crop).toHaveBeenCalledWith(display, { x: 0, y: 1, width: 10, height: 10 })
  expect(deps.onCaptured).toHaveBeenCalledTimes(1)
})

it.each([
  [new DisplayCaptureError('CAPTURE_UNAVAILABLE'), 'CAPTURE_UNAVAILABLE'],
  [new DisplayCaptureError('CAPTURE_EMPTY'), 'CAPTURE_EMPTY'],
  [new Error('C:\\private\\capture-driver.txt'), 'CAPTURE_UNAVAILABLE'],
] as const)('reports an initial capture failure once through the main-owned safe callback', async (failure, code) => {
  const owner = { name: 'owner' }
  const onCaptureFailed = vi.fn().mockResolvedValue(undefined)
  const { deps } = makeDependencies({
    capture: { captureAll: vi.fn().mockRejectedValue(failure), crop: vi.fn(() => validCrop()) },
    onCaptureFailed,
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)

  const first = coordinator.begin(owner)
  const second = coordinator.begin(owner)
  await expect(Promise.all([first, second])).resolves.toEqual([null, null])

  expect(onCaptureFailed).toHaveBeenCalledOnce()
  expect(onCaptureFailed).toHaveBeenCalledWith(owner, code)
  expect(JSON.stringify(onCaptureFailed.mock.calls)).not.toContain('private')
})

it('contains a rejected failure callback and does not report user cancellation as capture failure', async () => {
  const owner = { name: 'owner' }
  const onCaptureFailed = vi.fn().mockRejectedValue(new Error('dialog unavailable'))
  const initial = makeDependencies({
    capture: { captureAll: vi.fn().mockRejectedValue(new DisplayCaptureError('CAPTURE_EMPTY')), crop: vi.fn(() => validCrop()) },
    onCaptureFailed,
  })
  await expect(createScreenshotCaptureCoordinator(initial.deps).begin(owner)).resolves.toBeNull()

  const active = makeDependencies({ onCaptureFailed })
  const coordinator = createScreenshotCaptureCoordinator(active.deps)
  await coordinator.begin(owner)
  await expect(coordinator.cancel({ sessionId })).resolves.toBeUndefined()
  expect(onCaptureFailed).toHaveBeenCalledOnce()
})

it('single-flights concurrent begin and sends every ready snapshot before showing once', async () => {
  const captured = deferred<readonly CapturedDisplay[]>()
  const { deps, overlays, overlayOperations } = makeDependencies({
    capture: { captureAll: vi.fn(() => captured.promise), crop: vi.fn(() => validCrop()) },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  const first = coordinator.begin()
  const second = coordinator.begin()
  expect(first).toBe(second)
  captured.resolve([display, secondDisplay])
  await expect(first).resolves.toBe(sessionId)
  expect(overlays).toHaveLength(2)

  overlays[0].emit('ready-to-show')
  expect(overlays.every((overlay) => overlay.showInactive.mock.calls.length === 0)).toBe(true)
  overlays[1].emit('ready-to-show')
  await overlayOperations[0]!.ready({ sessionId, displayId: '1' })
  await overlayOperations[1]!.ready({ sessionId, displayId: '2' })
  for (const overlay of overlays) {
    const expectedBounds = overlay === overlays[0] ? display.snapshot.boundsDip : secondDisplay.snapshot.boundsDip
    expect(overlay.setBounds).toHaveBeenCalledWith(expectedBounds, false)
    expect(overlay.setFullScreen).toHaveBeenCalledWith(true)
    expect(overlay.setBounds).toHaveBeenCalledBefore(overlay.setFullScreen)
    expect(overlay.setFullScreen).toHaveBeenCalledBefore(overlay.webContents.send)
    expect(overlay.webContents.send).toHaveBeenCalledBefore(overlay.showInactive)
    expect(overlay.showInactive).toHaveBeenCalledOnce()
  }

  overlays[1].emit('ready-to-show')
  expect(overlays.every((overlay) => overlay.showInactive.mock.calls.length === 1)).toBe(true)
})

it('fails rather than showing when its content bounds remain at the display work area', async () => {
  vi.useFakeTimers()
  try {
    const workArea = { x: 0, y: 0, width: 100, height: 72 }
    const { deps, overlays } = makeDependencies()
    deps.createWindow = vi.fn(() => {
      const overlay = makeOverlay()
      overlay.getContentBounds.mockReturnValue(workArea)
      overlays.push(overlay)
      return overlay
    })
    const coordinator = createScreenshotCaptureCoordinator(deps)

    await expect(coordinator.begin()).resolves.toBe(sessionId)
    overlays[0].emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(500)

    expect(overlays[0].setBounds).toHaveBeenCalledWith(display.snapshot.boundsDip, false)
    expect(overlays[0].setFullScreen).toHaveBeenCalledWith(true)
    expect(overlays[0].webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'failed', code: 'CAPTURE_UNAVAILABLE' },
    )
    expect(overlays[0].showInactive).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('waits for fullscreen content bounds to settle before marking an overlay ready', async () => {
  vi.useFakeTimers()
  try {
    const workArea = { x: 0, y: 0, width: 100, height: 72 }
    const { deps, overlays, overlayOperations } = makeDependencies()
    const coordinator = createScreenshotCaptureCoordinator(deps)

    await expect(coordinator.begin()).resolves.toBe(sessionId)
    overlays[0].getContentBounds.mockReturnValueOnce(workArea).mockReturnValue(display.snapshot.boundsDip)
    overlays[0].emit('ready-to-show')
    expect(overlays[0].webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'selection-ready', display: display.snapshot },
    )
    expect(overlays[0].showInactive).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(25)
    await overlayOperations[0]!.ready({ sessionId, displayId: '1' })

    expect(overlays[0].webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'selection-ready', display: display.snapshot },
    )
    expect(overlays[0].showInactive).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('uses the enter-full-screen transition to activate after work-area bounds settle to the full display', async () => {
  vi.useFakeTimers()
  try {
    const workArea = { x: 0, y: 0, width: 100, height: 72 }
    const { deps, overlays, overlayOperations } = makeDependencies()
    const coordinator = createScreenshotCaptureCoordinator(deps)

    await expect(coordinator.begin()).resolves.toBe(sessionId)
    overlays[0].getContentBounds.mockReturnValue(workArea)
    overlays[0].emit('ready-to-show')
    await overlayOperations[0]!.ready({ sessionId, displayId: '1' })
    expect(overlays[0].listenerCount('enter-full-screen')).toBe(1)
    expect(overlays[0].showInactive).not.toHaveBeenCalled()

    overlays[0].getContentBounds.mockReturnValue(display.snapshot.boundsDip)
    overlays[0].emit('enter-full-screen')

    expect(overlays[0].webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'selection-ready', display: display.snapshot },
    )
    expect(overlays[0].showInactive).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('clears the fullscreen retry and listener when a pending overlay closes', async () => {
  vi.useFakeTimers()
  try {
    const workArea = { x: 0, y: 0, width: 100, height: 72 }
    const { deps, overlays } = makeDependencies()
    const coordinator = createScreenshotCaptureCoordinator(deps)

    await expect(coordinator.begin()).resolves.toBe(sessionId)
    overlays[0].getContentBounds.mockReturnValue(workArea)
    overlays[0].emit('ready-to-show')
    expect(overlays[0].listenerCount('enter-full-screen')).toBe(1)
    expect(vi.getTimerCount()).toBe(2)

    overlays[0].emit('closed')
    overlays[0].getContentBounds.mockReturnValue(display.snapshot.boundsDip)
    await vi.advanceTimersByTimeAsync(500)

    expect(vi.getTimerCount()).toBe(0)
    expect(overlays[0].listenerCount('enter-full-screen')).toBe(0)
    expect(overlays[0].webContents.send).toHaveBeenCalledWith(
      'screenshot-translation:capture-event',
      { sessionId, type: 'failed', code: 'CAPTURE_UNAVAILABLE' },
    )
    expect(overlays[0].showInactive).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('requires an owned overlay registration and fails before an overlay can show', async () => {
  const overlay = makeOverlay()
  const { deps } = makeDependencies({
    createWindow: vi.fn(() => overlay),
    registerOverlay: undefined as never,
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)

  await expect(coordinator.begin()).resolves.toBeNull()
  overlay.emit('ready-to-show')

  expect(overlay.show).not.toHaveBeenCalled()
  expect(overlay.showInactive).not.toHaveBeenCalled()
  expect(overlay.destroy).toHaveBeenCalledOnce()
})

it('disposes every registration even when an earlier disposer throws', async () => {
  const first = { dispose: vi.fn(() => { throw new Error('first disposer failed') }) }
  const second = { dispose: vi.fn() }
  let index = 0
  const { deps, overlays } = makeDependencies({
    capture: { captureAll: vi.fn().mockResolvedValue([display, secondDisplay]), crop: vi.fn(() => validCrop()) },
    registerOverlay: vi.fn(() => [first, second][index++]!),
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await expect(coordinator.cancel({ sessionId })).resolves.toBeUndefined()

  expect(first.dispose).toHaveBeenCalledOnce()
  expect(second.dispose).toHaveBeenCalledOnce()
  expect(overlays.every((overlay) => overlay.destroy.mock.calls.length === 1)).toBe(true)
})

it('chooses the owner display by both axes and repeated begin focuses the nearest active overlay', async () => {
  const { deps, overlays, overlayOperations } = makeDependencies({
    capture: { captureAll: vi.fn().mockResolvedValue([display, secondDisplay]), crop: vi.fn(() => validCrop()) },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)

  await coordinator.begin({ getBounds: () => ({ x: 10, y: 100, width: 20, height: 20 }) })
  overlays.forEach((overlay) => overlay.emit('ready-to-show'))
  await overlayOperations[0]!.ready({ sessionId, displayId: '1' })
  await overlayOperations[1]!.ready({ sessionId, displayId: '2' })
  expect(overlays[1].focus).toHaveBeenCalledOnce()
  expect(overlays[0].focus).not.toHaveBeenCalled()

  overlays.forEach((overlay) => overlay.focus.mockClear())
  await expect(coordinator.begin({ getBounds: () => ({ x: 10, y: 10, width: 20, height: 20 }) })).resolves.toBe(sessionId)
  expect(overlays[0].focus).toHaveBeenCalledOnce()
  expect(overlays[1].focus).not.toHaveBeenCalled()
})

it('does not cancel when focus moves between display overlays but cancels when all are blurred', async () => {
  vi.useFakeTimers()
  try {
    const { deps, overlays, registrations } = makeDependencies({
      capture: { captureAll: vi.fn().mockResolvedValue([display, secondDisplay]), crop: vi.fn(() => validCrop()) },
    })
    const coordinator = createScreenshotCaptureCoordinator(deps)
    await coordinator.begin()
    overlays.forEach((overlay) => overlay.emit('ready-to-show'))
    await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
    overlays[0].setFocused(false)
    overlays[1].setFocused(true)
    overlays[0].emit('blur')
    await vi.advanceTimersByTimeAsync(100)
    expect(overlays[0].destroy).not.toHaveBeenCalled()
    expect(overlays[1].destroy).not.toHaveBeenCalled()
    expect(registrations.every((registration) => registration.dispose.mock.calls.length === 0)).toBe(true)
    expect(overlays.some((overlay) => overlay.webContents.send.mock.calls.some(([, event]) => (
      event as { type?: string }
    ).type === 'cancelled'))).toBe(false)

    overlays[1].setFocused(false)
    overlays[1].emit('blur')
    await vi.advanceTimersByTimeAsync(100)
    expect(overlays[0].destroy).toHaveBeenCalledOnce()
    expect(overlays[1].destroy).toHaveBeenCalledOnce()
    expect(registrations.every((registration) => registration.dispose.mock.calls.length === 1)).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})

it('clears a prior native hit when the release point is outside the display', async () => {
  const hitTest = vi.fn().mockResolvedValue({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 100, y: 80 } })
  await expect(coordinator.commit({ sessionId, displayId: '1', kind: 'window', processId: 77, rectDip: { x: 5, y: 5, width: 20, height: 20 } })).rejects.toMatchObject({ code: 'OPERATION_FAILED' })

  expect(deps.onCaptured).not.toHaveBeenCalled()
  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: null },
  )
})

it('keeps a visible hit until a newer probe atomically replaces it', async () => {
  const second = deferred<{ hwnd: string; processCreationIdentity: string; processId: number; boundsPx: { x: number; y: number; width: number; height: number } } | null>()
  const hitTest = vi.fn()
    .mockResolvedValueOnce({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
    .mockReturnValueOnce(second.promise)
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  const replacement = coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 20, y: 20 } })

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 77, rectDip: { x: 5, y: 5, width: 20, height: 20 } } },
  )
  second.resolve({ hwnd: '10088', processCreationIdentity: '132000000000000000', processId: 88, boundsPx: { x: 20, y: 20, width: 10, height: 10 } })
  await replacement

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 88, rectDip: { x: 20, y: 20, width: 10, height: 10 } } },
  )
})

it('clears an existing hit once when the newest probe genuinely finds no window', async () => {
  const hitTest = vi.fn()
    .mockResolvedValueOnce({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
    .mockResolvedValueOnce(null)
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 30, y: 30 } })

  const clears = overlays[0].webContents.send.mock.calls.filter(([, event]) => (
    (event as { type?: string; hit?: unknown }).type === 'window-highlight'
      && (event as { hit?: unknown }).hit === null
  ))
  expect(clears).toHaveLength(1)
  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: null },
  )
})

it('does not publish a late hit after disposal', async () => {
  const late = deferred<{ hwnd: string; processCreationIdentity: string; processId: number; boundsPx: { x: number; y: number; width: number; height: number } } | null>()
  const { deps, overlays } = makeDependencies({
    hitTest: { hitTest: vi.fn(() => late.promise), dispose: vi.fn() },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  const probe = coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.dispose()
  late.resolve({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
  await probe

  expect(overlays[0].webContents.send.mock.calls.some(([, event]) => (
    (event as { type?: string; hit?: unknown }).type === 'window-highlight'
      && (event as { hit?: unknown }).hit !== null
  ))).toBe(false)
})

it('keeps the visible hit when a newer native probe fails', async () => {
  const hitTest = vi.fn()
    .mockResolvedValueOnce({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
    .mockRejectedValueOnce(new Error('native probe unavailable'))
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 30, y: 30 } })

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 77, rectDip: { x: 5, y: 5, width: 20, height: 20 } } },
  )
})

it('clears a retained visual hit when the probe after a native failure genuinely finds no window', async () => {
  const hitTest = vi.fn()
    .mockResolvedValueOnce({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
    .mockRejectedValueOnce(new Error('native probe unavailable'))
    .mockResolvedValueOnce(null)
  const { deps, overlays } = makeDependencies({ hitTest: { hitTest, dispose: vi.fn() } })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 20, y: 20 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 30, y: 30 } })

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: null },
  )
})

it('clears the old display only when the newest display probe resolves', async () => {
  const second = deferred<{ hwnd: string; processCreationIdentity: string; processId: number; boundsPx: { x: number; y: number; width: number; height: number } } | null>()
  const hitTest = vi.fn()
    .mockResolvedValueOnce({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 20, height: 20 } })
    .mockReturnValueOnce(second.promise)
  const { deps, overlays } = makeDependencies({
    capture: { captureAll: vi.fn().mockResolvedValue([display, secondDisplay]), crop: vi.fn(() => validCrop()) },
    hitTest: { hitTest, dispose: vi.fn() },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })

  const replacement = coordinator.updatePointer({ sessionId, displayId: '2', screenPointDip: { x: 10, y: 90 } })
  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 77, rectDip: { x: 5, y: 5, width: 20, height: 20 } } },
  )
  second.resolve({ hwnd: '10088', processCreationIdentity: '132000000000000000', processId: 88, boundsPx: { x: 10, y: 90, width: 20, height: 20 } })
  await replacement

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: null },
  )
  expect(overlays[1].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '2', hit: { processId: 88, rectDip: { x: 10, y: 90, width: 20, height: 20 } } },
  )
})

it('binds hit results to the newest pointer generation and clears conversion failures', async () => {
  const first = deferred<{ hwnd: string; processCreationIdentity: string; processId: number; boundsPx: { x: number; y: number; width: number; height: number } } | null>()
  const second = deferred<{ hwnd: string; processCreationIdentity: string; processId: number; boundsPx: { x: number; y: number; width: number; height: number } } | null>()
  const hitTest = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const screenToDipRect = vi.fn((_display: null, rect: { x: number; y: number; width: number; height: number }) => rect)
  const { deps, overlays } = makeDependencies({
    hitTest: { hitTest, dispose: vi.fn() },
    screen: { dipToScreenPoint: (point) => point, screenToDipRect },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  const oldProbe = coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 10, y: 10 } })
  const newProbe = coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 20, y: 20 } })
  second.resolve({ hwnd: '10088', processCreationIdentity: '132000000000000000', processId: 88, boundsPx: { x: 20, y: 20, width: 10, height: 10 } })
  await newProbe
  first.resolve({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 5, y: 5, width: 10, height: 10 } })
  await oldProbe

  expect(overlays[0].webContents.send).toHaveBeenLastCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'window-highlight', displayId: '1', hit: { processId: 88, rectDip: { x: 20, y: 20, width: 10, height: 10 } } },
  )

  screenToDipRect.mockImplementationOnce(() => { throw new Error('conversion failed') })
  hitTest.mockResolvedValueOnce({ hwnd: '10099', processCreationIdentity: '132000000000000000', processId: 99, boundsPx: { x: 30, y: 30, width: 10, height: 10 } })
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 30, y: 30 } })
  await expect(coordinator.commit({ sessionId, displayId: '1', kind: 'window', processId: 88, rectDip: { x: 20, y: 20, width: 10, height: 10 } })).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(deps.onCaptured).not.toHaveBeenCalled()
})

it('converts pointer and native bounds across DPI and rejects a spoofed window commit', async () => {
  const hitTest = vi.fn().mockResolvedValue({ hwnd: '10077', processCreationIdentity: '132000000000000000', processId: 77, boundsPx: { x: 300, y: 400, width: 80, height: 60 } })
  const { deps } = makeDependencies({
    hitTest: { hitTest, dispose: vi.fn() },
    screen: {
      dipToScreenPoint: (point) => ({ x: point.x * 2, y: point.y * 2 }),
      screenToDipRect: (_display, _rect) => ({ x: -5, y: 5, width: 30, height: 20 }),
    },
    excludedWindowHandles: () => new Set(['7']),
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  await coordinator.updatePointer({ sessionId, displayId: '1', screenPointDip: { x: 15, y: 20 } })

  expect(hitTest).toHaveBeenCalledWith({ x: 30, y: 40 }, new Set(['7', '100']))
  await expect(coordinator.commit({
    sessionId, displayId: '1', kind: 'window', processId: 77,
    rectDip: { x: 0, y: 5, width: 24, height: 20 },
  })).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  expect(deps.onCaptured).not.toHaveBeenCalled()

  await coordinator.commit({
    sessionId, displayId: '1', kind: 'window', processId: 77,
    rectDip: { x: 0, y: 5, width: 25, height: 20 },
  })
  expect(deps.onCaptured).toHaveBeenCalledOnce()
})

it('reports result-consumer rejection through the main-owned safe failure callback', async () => {
  const privateError = new Error('C:\\private\\result-window.ts failed')
  const onDeliveryFailed = vi.fn().mockResolvedValue(undefined)
  const { deps, overlays } = makeDependencies({
    onCaptured: vi.fn().mockRejectedValue(privateError),
    onDeliveryFailed,
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()

  await expect(coordinator.commit({
    sessionId, displayId: '1', kind: 'region', rectDip: { x: 1, y: 1, width: 10, height: 10 },
  })).resolves.toBeUndefined()

  expect(overlays[0].destroy).toHaveBeenCalledOnce()
  expect(onDeliveryFailed).toHaveBeenCalledWith('CAPTURE_UNAVAILABLE')
  expect(JSON.stringify(onDeliveryFailed.mock.calls)).not.toContain('private')
})

it('closes every overlay before delivering the result and dispose waits for late delivery', async () => {
  const delivery = deferred<void>()
  const onCaptured = vi.fn(() => delivery.promise)
  const { deps, overlays } = makeDependencies({ onCaptured })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin()
  const commit = coordinator.commit({ sessionId, displayId: '1', kind: 'region', rectDip: { x: 1, y: 1, width: 10, height: 10 } })
  await vi.waitFor(() => expect(onCaptured).toHaveBeenCalledOnce())

  expect(overlays[0].destroy).toHaveBeenCalledBefore(onCaptured)
  let disposed = false
  const dispose = coordinator.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  delivery.resolve()
  await Promise.all([commit, dispose])
  expect(deps.hitTest.dispose).toHaveBeenCalledOnce()
})

it('preserves native capture failure codes and never calls the result consumer', async () => {
  const owner = { name: 'owner' }
  const { deps, overlays } = makeDependencies({
    capture: {
      captureAll: vi.fn().mockResolvedValue([display]),
      crop: vi.fn(() => { throw new DisplayCaptureError('CAPTURE_UNAVAILABLE') }),
    },
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  await coordinator.begin(owner)
  await coordinator.commit({ sessionId, displayId: '1', kind: 'region', rectDip: { x: 0, y: 0, width: 1, height: 1 } })

  expect(overlays[0].webContents.send).toHaveBeenCalledWith(
    'screenshot-translation:capture-event',
    { sessionId, type: 'failed', code: 'CAPTURE_UNAVAILABLE' },
  )
  expect(deps.onCaptured).not.toHaveBeenCalled()
  expect(deps.onCaptureFailed).toHaveBeenCalledOnce()
  expect(deps.onCaptureFailed).toHaveBeenCalledWith(owner, 'CAPTURE_UNAVAILABLE')
})

it('blocks future sessions after dispose even if a capture finishes late', async () => {
  const capture = deferred<readonly CapturedDisplay[]>()
  const { deps } = makeDependencies({
    capture: { captureAll: vi.fn(() => capture.promise), crop: vi.fn(() => validCrop()) },
    createSessionId: vi.fn().mockReturnValueOnce(sessionId).mockReturnValue(secondSessionId),
  })
  const coordinator = createScreenshotCaptureCoordinator(deps)
  const begin = coordinator.begin()
  const dispose = coordinator.dispose()
  capture.resolve([display])
  await expect(begin).resolves.toBeNull()
  await dispose
  await expect(coordinator.begin()).resolves.toBeNull()
  expect(deps.createWindow).not.toHaveBeenCalled()
})

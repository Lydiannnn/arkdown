import { StrictMode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ScreenshotOcrHost } from '../../src/renderer/screenshot/ScreenshotOcrHost'
import type { ArkdownApi } from '../../src/shared/contracts'
import type {
  ScreenshotOcrHostCommand,
  ScreenshotOcrSubmission,
  ScreenshotTranslationGenerationInput,
} from '../../src/shared/screenshot-translation'

const SESSION_1 = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_2 = '223e4567-e89b-42d3-a456-426614174000'

it('keeps both synchronously replayed recognize jobs through the StrictMode effect remount', async () => {
  const commands: ScreenshotOcrHostCommand[] = [SESSION_1, SESSION_2].map((sessionId) => ({
    type: 'recognize',
    sessionId,
    generation: 1,
    image: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' },
    tier: 'small',
    cacheKey: 'small:6.0.0',
  }))
  const unsubscribeCommands = vi.fn()
  const unsubscribeModelState = vi.fn()
  const submit = vi.fn(async (_input: ScreenshotOcrSubmission) => ({ ok: true as const, value: null }))
  const settle = vi.fn(async (_input: ScreenshotTranslationGenerationInput) => ({ ok: true as const, value: null }))
  const api = {
    ...window.arkdown,
    onScreenshotOcrHostCommand: vi.fn((listener: (command: ScreenshotOcrHostCommand) => void) => {
      for (const command of commands.splice(0)) listener(command)
      return unsubscribeCommands
    }),
    onScreenshotOcrModelState: vi.fn(() => unsubscribeModelState),
    submitScreenshotOcr: submit,
    settleScreenshotOcr: settle,
  } as ArkdownApi
  Object.defineProperty(window, 'arkdown', { configurable: true, value: api })

  render(<StrictMode><ScreenshotOcrHost /></StrictMode>)

  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
  expect(submit.mock.calls.map(([submission]) => submission)).toEqual([
    { sessionId: SESSION_1, generation: 1, status: 'failure', code: 'OCR_FAILED' },
    { sessionId: SESSION_2, generation: 1, status: 'failure', code: 'OCR_FAILED' },
  ])
  await waitFor(() => expect(settle).toHaveBeenCalledTimes(2))
  expect(api.onScreenshotOcrHostCommand).toHaveBeenCalledOnce()
  expect(unsubscribeCommands).not.toHaveBeenCalled()

  window.dispatchEvent(new Event('pagehide'))
  expect(unsubscribeCommands).toHaveBeenCalledOnce()
  expect(unsubscribeModelState).toHaveBeenCalledOnce()
})

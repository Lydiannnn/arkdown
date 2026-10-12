import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  parseLocalPaddleOcrEvidence,
  parseWindowsOcrEvidence,
  validateStartedNativeSource,
} from './windows-screenshot-source'

describe('native screenshot source startup', () => {
  it('submits the complete screenshot shortcut as one checked Win32 input batch', () => {
    const source = readFileSync(path.resolve('tests/e2e/fixtures/windows-send-shortcut.ps1'), 'utf8')
    expect(source).toContain('SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length')
    expect(source).toContain('Keyboard(Shift, 0)')
    expect(source).toContain('Keyboard(Shift, KeyUp)')
    expect(source).not.toContain('keybd_event')
  })

  it('derives redacted evidence from the exact bounded translation request shape', () => {
    expect(parseLocalPaddleOcrEvidence([
      { id: 'line-1', text: 'Codex 8172' },
      { id: 'line-2', text: '中英混合' },
    ], ['Codex', '中英混合'], ['private-marker'])).toEqual({
      language: 'mul', status: 'completed', blockCount: 2, wordCount: 3,
    })
  })

  it.each([
    { name: 'readiness rejection', read: async () => await Promise.reject(new Error('timeout')) },
    { name: 'invalid JSON', read: async () => '{' },
    { name: 'invalid metadata', read: async () => '{"pid":0}' },
  ])('cleans up the spawned process after $name', async ({ read }) => {
    const child = { pid: 42 }
    const cleanup = vi.fn(async () => undefined)

    await expect(validateStartedNativeSource({
      child,
      cleanup,
      readFirstLine: read,
      validate: (value): value is { pid: number } => (
        typeof value === 'object'
        && value !== null
        && (value as { pid?: unknown }).pid === 42
      ),
    })).rejects.toThrow()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledWith(child)
  })

  it('returns valid metadata without cleaning up the live fixture', async () => {
    const child = { pid: 42 }
    const cleanup = vi.fn(async () => undefined)

    await expect(validateStartedNativeSource({
      child,
      cleanup,
      readFirstLine: async () => '{"pid":42}',
      validate: (value): value is { pid: number } => (
        typeof value === 'object'
        && value !== null
        && (value as { pid?: unknown }).pid === 42
      ),
    })).resolves.toEqual({ pid: 42 })
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('derives language and exact WinRT block/word rectangle counts from bridge output', () => {
    expect(parseWindowsOcrEvidence({
      status: 'ok',
      width: 400,
      height: 200,
      language: 'en-US',
      blocks: [{
        id: 'line-1',
        text: 'ARKDOWN OCR',
        rectPx: { x: 10, y: 20, width: 180, height: 40 },
        words: [
          { text: 'ARKDOWN', rectPx: { x: 10, y: 20, width: 90, height: 40 } },
          { text: 'OCR', rectPx: { x: 100, y: 20, width: 90, height: 40 } },
        ],
      }],
    })).toEqual({ language: 'en-US', status: 'completed', blockCount: 1, wordCount: 2 })
  })

  it.each([
    { status: 'ok', width: 400, height: 200, language: 'en-US', blocks: [], path: 'capture.png' },
    { status: 'ok', width: 400, height: 200, language: 'bad language', blocks: [] },
    { status: 'error', code: 'ocr-failed' },
  ])('rejects non-authoritative OCR bridge evidence: %#', (value) => {
    expect(() => parseWindowsOcrEvidence(value)).toThrow('Invalid Windows OCR evidence')
  })
})

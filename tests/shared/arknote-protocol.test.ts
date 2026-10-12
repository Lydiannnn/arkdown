import { describe, expect, it } from 'vitest'
import {
  ARKNOTE_PROTOCOL_VERSION,
  ARKNOTE_DEFAULT_MAX_FRAME_BYTES,
  ArknoteFrameDecoder,
  arknotePipeName,
  encodeArknoteFrame,
  parseArknoteRequest,
} from '../../src/shared/arknote-protocol'
import { deleteArchivedStickyNotesSchema } from '../../src/main/ipc/sticky-note-schemas'

describe('Arknote wire protocol', () => {
  it('derives a stable local pipe name from the portable application directory', () => {
    const first = arknotePipeName('C:\\Portable\\Arkdown')
    expect(first).toBe(arknotePipeName('c:\\portable\\arkdown\\'))
    expect(first).not.toBe(arknotePipeName('C:\\Portable\\Other'))
    expect(first).toMatch(/^\\\\\.\\pipe\\arknote-[a-f0-9]{32}$/u)
  })

  it('rejects unknown commands, versions, and extra request fields', () => {
    const base = {
      kind: 'request',
      version: ARKNOTE_PROTOCOL_VERSION,
      requestId: 'ef05b3ad-07cb-4f22-8441-f29371b6001c',
      command: 'health.ping',
      payload: { value: 'ok' },
    }
    expect(parseArknoteRequest(base)).toEqual(base)
    expect(parseArknoteRequest({ ...base, version: 2 })).toBeUndefined()
    expect(parseArknoteRequest({ ...base, command: 'filesystem.write' })).toBeUndefined()
    expect(parseArknoteRequest({ ...base, extra: true })).toBeUndefined()
  })

  it('decodes messages split across arbitrary transport chunks', () => {
    const frame = encodeArknoteFrame({ kind: 'event', value: '同步' })
    const decoder = new ArknoteFrameDecoder()
    expect(decoder.push(frame.subarray(0, 3))).toEqual([])
    expect(decoder.push(frame.subarray(3, 8))).toEqual([])
    expect(decoder.push(frame.subarray(8))).toEqual([{ kind: 'event', value: '同步' }])
  })

  it('rejects frames larger than the protocol maximum before buffering the body', () => {
    const decoder = new ArknoteFrameDecoder(16)
    const header = Buffer.alloc(4)
    header.writeUInt32BE(17)
    expect(() => decoder.push(header)).toThrow('Arknote frame exceeds 16 bytes')
  })
})


it('accepts the line-spacing command in a strict request envelope', () => {
  const request = {
    kind: 'request',
    version: ARKNOTE_PROTOCOL_VERSION,
    requestId: 'ef05b3ad-07cb-4f22-8441-f29371b6001c',
    command: 'note.line-spacing',
    payload: {
      noteId: '00000000-0000-4000-8000-000000000001',
      lineSpacingMode: 'standard',
    },
  }

  expect(parseArknoteRequest(request)).toEqual(request)
})

it('accepts the archived batch-restore command in a strict request envelope', () => {
  const request = {
    kind: 'request',
    version: ARKNOTE_PROTOCOL_VERSION,
    requestId: 'ef05b3ad-07cb-4f22-8441-f29371b6001c',
    command: 'note.restore-archived-batch',
    payload: { noteIds: ['00000000-0000-4000-8000-000000000001'] },
  }

  expect(parseArknoteRequest(request)).toEqual(request)
})

it('accepts the archived batch-delete command in a strict request envelope', () => {
  const request = {
    kind: 'request',
    version: ARKNOTE_PROTOCOL_VERSION,
    requestId: 'ef05b3ad-07cb-4f22-8441-f29371b6001c',
    command: 'note.delete-archived-batch',
    payload: { noteIds: ['00000000-0000-4000-8000-000000000001'] },
  }

  expect(parseArknoteRequest(request)).toEqual(request)
})

it('round-trips the maximum accepted archived batch in one pipe frame', () => {
  const noteId = '00000000-0000-4000-8000-000000000001'
  const request = {
    kind: 'request' as const,
    version: ARKNOTE_PROTOCOL_VERSION,
    requestId: 'ef05b3ad-07cb-4f22-8441-f29371b6001c',
    command: 'note.delete-archived-batch' as const,
    payload: { noteIds: Array.from({ length: 100_000 }, () => noteId) },
  }

  const messages = new ArknoteFrameDecoder().push(encodeArknoteFrame(request))
  expect(messages).toHaveLength(1)
  const parsedRequest = parseArknoteRequest(messages[0])
  expect(parsedRequest?.command).toBe('note.delete-archived-batch')
  const parsedPayload = deleteArchivedStickyNotesSchema.safeParse(parsedRequest?.payload)
  expect(parsedPayload.success).toBe(true)
  if (!parsedPayload.success) return
  expect(parsedPayload.data.noteIds).toHaveLength(100_000)
  expect(parsedPayload.data.noteIds[0]).toBe(noteId)
  expect(parsedPayload.data.noteIds[99_999]).toBe(noteId)
})

it('rejects frames beyond the default pipe cap in both encoder and decoder', () => {
  expect(() => encodeArknoteFrame({
    value: 'x'.repeat(ARKNOTE_DEFAULT_MAX_FRAME_BYTES),
  })).toThrow(`Arknote frame exceeds ${ARKNOTE_DEFAULT_MAX_FRAME_BYTES} bytes`)

  const header = Buffer.alloc(4)
  header.writeUInt32BE(ARKNOTE_DEFAULT_MAX_FRAME_BYTES + 1)
  expect(() => new ArknoteFrameDecoder().push(header))
    .toThrow(`Arknote frame exceeds ${ARKNOTE_DEFAULT_MAX_FRAME_BYTES} bytes`)
})

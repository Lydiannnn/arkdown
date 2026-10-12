import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

export const ARKNOTE_PROTOCOL_VERSION = 1 as const
export const ARKNOTE_DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024

export const ARKNOTE_COMMANDS = [
  'health.ping',
  'launch.open-box',
  'launch.new-note',
  'launch.open-settings',
  'note.list',
  'note.reorder',
  'note.read',
  'note.create',
  'note.rename',
  'note.archive',
  'note.restore',
  'note.restore-archived-batch',
  'note.delete',
  'note.delete-archived-batch',
  'note.import-file',
  'note.import-selection',
  'note.stage-save',
  'note.flush-save',
  'note.open',
  'note.close',
  'note.release',
  'note.reclaim',
  'note.pin',
  'note.style',
  'note.line-spacing',
  'note.resize',
  'note.search',
  'settings.get',
  'settings.set',
  'settings.preview-theme',
  'settings.box-theme',
  'service.quit',
  'service.prepare-update',
  'service.cancel-update',
] as const

export type ArknoteCommand = typeof ARKNOTE_COMMANDS[number]

export interface ArknoteRequest {
  kind: 'request'
  version: 1
  requestId: string
  command: ArknoteCommand
  payload: unknown
}

export interface ArknoteHello {
  kind: 'hello'
  version: 1
  token: string
}

export type ArknoteHelloResponse =
  | { kind: 'hello-accepted'; version: 1 }
  | { kind: 'hello-rejected'; version: 1; message: string }

export type ArknoteResponse =
  | { kind: 'response'; version: 1; requestId: string; ok: true; value: unknown }
  | { kind: 'response'; version: 1; requestId: string; ok: false; error: { message: string } }

export interface ArknoteEventFrame {
  kind: 'event'
  version: 1
  event: unknown
}

const RequestSchema = z.object({
  kind: z.literal('request'),
  version: z.literal(ARKNOTE_PROTOCOL_VERSION),
  requestId: z.string().uuid(),
  command: z.enum(ARKNOTE_COMMANDS),
  payload: z.unknown(),
}).strict()

const HelloSchema = z.object({
  kind: z.literal('hello'),
  version: z.literal(ARKNOTE_PROTOCOL_VERSION),
  token: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

const HelloResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hello-accepted'),
    version: z.literal(ARKNOTE_PROTOCOL_VERSION),
  }).strict(),
  z.object({
    kind: z.literal('hello-rejected'),
    version: z.literal(ARKNOTE_PROTOCOL_VERSION),
    message: z.string().min(1).max(200),
  }).strict(),
])

const ResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('response'),
    version: z.literal(ARKNOTE_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(true),
    value: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal('response'),
    version: z.literal(ARKNOTE_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
    ok: z.literal(false),
    error: z.object({ message: z.string().min(1).max(500) }).strict(),
  }).strict(),
])

const EventFrameSchema = z.object({
  kind: z.literal('event'),
  version: z.literal(ARKNOTE_PROTOCOL_VERSION),
  event: z.unknown(),
}).strict()

export function arknotePipeName(applicationDirectory: string): string {
  const canonical = path.win32.normalize(applicationDirectory)
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32)
  return `\\\\.\\pipe\\arknote-${digest}`
}

export function parseArknoteRequest(value: unknown): ArknoteRequest | undefined {
  const parsed = RequestSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseArknoteHello(value: unknown): ArknoteHello | undefined {
  const parsed = HelloSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseArknoteHelloResponse(value: unknown): ArknoteHelloResponse | undefined {
  const parsed = HelloResponseSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseArknoteResponse(value: unknown): ArknoteResponse | undefined {
  const parsed = ResponseSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function parseArknoteEventFrame(value: unknown): ArknoteEventFrame | undefined {
  const parsed = EventFrameSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function encodeArknoteFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.byteLength > ARKNOTE_DEFAULT_MAX_FRAME_BYTES) {
    throw new Error(`Arknote frame exceeds ${ARKNOTE_DEFAULT_MAX_FRAME_BYTES} bytes`)
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength)
  frame.writeUInt32BE(body.byteLength, 0)
  body.copy(frame, 4)
  return frame
}

export class ArknoteFrameDecoder {
  private buffered = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes = ARKNOTE_DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.buffered = this.buffered.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffered, chunk])
    const messages: unknown[] = []
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32BE(0)
      if (length > this.maxFrameBytes) {
        this.buffered = Buffer.alloc(0)
        throw new Error(`Arknote frame exceeds ${this.maxFrameBytes} bytes`)
      }
      if (this.buffered.byteLength < length + 4) break
      const body = this.buffered.subarray(4, length + 4)
      this.buffered = this.buffered.subarray(length + 4)
      try {
        messages.push(JSON.parse(body.toString('utf8')) as unknown)
      } catch {
        throw new Error('Arknote frame contains invalid JSON')
      }
    }
    return messages
  }
}

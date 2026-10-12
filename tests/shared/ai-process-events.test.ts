import { describe, expect, it, vi } from 'vitest'
import * as events from '../../src/shared/ai-process-events'

const requestId = '10000000-0000-4000-8000-000000000001'
const messageId = '20000000-0000-4000-8000-000000000001'
const itemId = '30000000-0000-4000-8000-000000000001'
const envelope = { requestId, messageId, round: 1, sequence: 1 }
const textEvent = () => ({ ...envelope, type: 'process-text', kind: 'reasoning-summary', itemId, segmentIndex: 0, delta: 'Line one\n继续。', delivery: 'stream' })
const toolEvent = () => ({ ...envelope, type: 'process-tool', toolCallId: 'call-1', toolName: 'read_workspace_document', status: 'running', operationId: null, paths: ['docs/report.md'], displayName: null, cached: false })
function parse(value: unknown) {
  expect(events.parseAiProcessEvent).toBeTypeOf('function')
  return events.parseAiProcessEvent(value)
}

describe('strict visible AI process events', () => {
  it('keeps readable text separate, verbatim and immutable', () => {
    const value = textEvent()
    expect(parse(value)).toEqual(value)
    expect(Object.isFrozen(parse(value))).toBe(true)
    expect(parse({ ...value, delivery: 'complete', kind: 'commentary' })).toMatchObject({ delivery: 'complete', kind: 'commentary' })
  })
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid round and sequence %s', invalid => {
    expect(parse({ ...textEvent(), round: invalid })).toBeUndefined()
    expect(parse({ ...textEvent(), sequence: invalid })).toBeUndefined()
  })
  it('requires owned opaque IDs, finite segments, and known channel/delivery', () => {
    for (const field of ['requestId', 'messageId', 'itemId']) expect(parse({ ...textEvent(), [field]: 'C:/private/token' })).toBeUndefined()
    expect(parse({ ...textEvent(), segmentIndex: -1 })).toBeUndefined()
    expect(parse({ ...textEvent(), kind: 'encrypted_content' })).toBeUndefined()
    expect(parse({ ...textEvent(), delivery: 'replayed' })).toBeUndefined()
  })
  it('enforces the UTF-8 payload boundary without trimming legitimate whitespace', () => {
    expect(parse({ ...textEvent(), delta: '😀'.repeat(4096) })).toBeDefined()
    expect(parse({ ...textEvent(), delta: '😀'.repeat(4096) + 'a' })).toBeUndefined()
    expect(parse({ ...textEvent(), delta: '' })).toBeUndefined()
    expect(parse({ ...textEvent(), delta: '  \n' })).toMatchObject({ delta: '  \n' })
  })
  it('rejects extra keys, prototypes and accessor discriminants without invoking them', () => {
    expect(parse({ ...textEvent(), encrypted_content: 'never display' })).toBeUndefined()
    expect(parse(Object.assign(Object.create({}), textEvent()))).toBeUndefined()
    const accessor = vi.fn(() => 'process-text')
    const value = textEvent()
    Object.defineProperty(value, 'type', { enumerable: true, get: accessor })
    expect(parse(value)).toBeUndefined()
    expect(accessor).not.toHaveBeenCalled()
    Object.defineProperty(value, 'type', { value: 'process-text', enumerable: true })
    Object.defineProperty(value, 'delta', { enumerable: true, get: accessor })
    expect(parse(value)).toBeUndefined()
    expect(accessor).not.toHaveBeenCalled()
  })
  it('accepts only actual finite stages, not an arbitrary model-authored status', () => {
    expect(parse({ ...envelope, type: 'process-stage', stage: 'waiting-model' })).toMatchObject({ stage: 'waiting-model' })
    expect(parse({ ...envelope, type: 'process-stage', stage: 'all-files-successfully-written' })).toBeUndefined()
    expect(parse({ ...envelope, type: 'process-stage', stage: 'thinking', rawArguments: {} })).toBeUndefined()
  })
  it('requires relative tool targets and an operation ID only for mutations', () => {
    expect(parse(toolEvent())).toEqual(toolEvent())
    expect(parse({ ...toolEvent(), paths: ['C:/secret/file.md'] })).toBeUndefined()
    expect(parse({ ...toolEvent(), paths: ['../outside.md'] })).toBeUndefined()
    expect(parse({ ...toolEvent(), operationId: itemId })).toBeUndefined()
    expect(parse({ ...toolEvent(), toolName: 'edit_workspace_document', operationId: itemId, status: 'succeeded' })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'edit_workspace_document', status: 'succeeded' })).toBeUndefined()
    expect(parse({ ...toolEvent(), toolName: 'edit_workspace_document', status: 'not-executed' })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'edit_workspace_document', status: 'unavailable' })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'rename_workspace_document', operationId: itemId, paths: ['old.md', 'new.md'] })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'rename_workspace_document', operationId: itemId })).toBeUndefined()
  })
  it('allows current-document display names and root listing without fabricating a path', () => {
    expect(parse({ ...toolEvent(), toolName: 'read_current_document', paths: [], displayName: 'Untitled.md' })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'read_current_document', paths: [], displayName: 'C:\\Secret\\Untitled.md' })).toBeUndefined()
    expect(parse({ ...toolEvent(), toolName: 'list_workspace_entries', paths: [] })).toBeDefined()
    expect(parse({ ...toolEvent(), toolName: 'read_current_document', paths: [] })).toBeDefined()
  })
  it('never labels a cached result as a newly running or authorization-pending operation', () => {
    expect(parse({ ...toolEvent(), cached: true })).toBeUndefined()
    expect(parse({ ...toolEvent(), status: 'succeeded', cached: true })).toBeDefined()
    expect(parse({ ...toolEvent(), status: 'awaiting-approval', cached: true })).toBeUndefined()
    expect(parse({ ...toolEvent(), status: 'not-executed', cached: false })).toBeDefined()
  })
  it('clones and freezes tool paths and rejects array accessors or surplus properties', () => {
    const value = toolEvent()
    const decoded = parse(value)
    value.paths[0] = 'changed.md'
    expect(decoded).toMatchObject({ paths: ['docs/report.md'] })
    const getter = vi.fn(() => 'docs/report.md')
    Object.defineProperty(value.paths, '0', { get: getter, enumerable: true })
    expect(parse(value)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(parse({ ...toolEvent(), paths: Object.assign(['docs/report.md'], { extra: true }) })).toBeUndefined()
  })
})

it('accepts the finite safe recycle fact only for a failed delete with an operation', () => {
  const value = { ...toolEvent(), toolName: 'delete_workspace_document', operationId: itemId, status: 'failed', reason: 'recycle-unavailable' }
  expect(parse(value)).toEqual(value)
  expect(parse({ ...value, toolName: 'edit_workspace_document' })).toBeUndefined()
  expect(parse({ ...value, toolName: 'read_workspace_document', operationId: null })).toBeUndefined()
  for (const status of ['running', 'succeeded', 'unknown', 'unavailable', 'not-executed']) expect(parse({ ...value, status })).toBeUndefined()
  expect(parse({ ...value, operationId: null })).toBeUndefined()
  expect(parse({ ...value, reason: 'raw error' })).toBeUndefined()
  expect(parse({ ...value, reason: undefined })).toBeUndefined()
  expect(parse({ ...value, guidance: 'raw error' })).toBeUndefined()
  const getter = vi.fn(() => 'recycle-unavailable')
  Object.defineProperty(value, 'reason', { enumerable: true, get: getter })
  expect(parse(value)).toBeUndefined()
  expect(getter).not.toHaveBeenCalled()
})

// @vitest-environment node
import { expect, it } from 'vitest'

const modulePath = '../../src/main/updates/update-diagnostic'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/main/updates/update-diagnostic')
export const diagnostic = () => ({ schemaVersion: 1, origin: 'helper', phase: 'stage.verify.open', operation: 'CreateFileW',
  pathScope: 'stage', relativePath: 'resources/app.asar', pathPrecision: 'exact', ancestorLevelsAboveSession: null,
  exceptionType: 'System.ComponentModel.Win32Exception', nativeErrorCode: 32, nativeCodeSource: 'Win32Exception',
  hresult: -2147467259, access: 2147483648, share: 1, creation: 3, flags: 2097152, validationReason: null,
  primaryStack: '   at Arkdown.Update.Native.Validate(SafeFileHandle h)\n   at Arkdown.Update.PackageStage.Extract(String package)', terminalStack: null })
const roots = { session: 'C:\\Users\\synthetic\\.ArkdownUpdate-abc', stage: 'C:\\Users\\synthetic\\.ArkdownUpdate-abc\\stage',
  target: 'C:\\Users\\synthetic\\Arkdown', package: 'C:\\Users\\synthetic\\.ArkdownUpdate-abc\\update.zip' }

it('accepts a bounded helper failure snapshot independently of its mutable input', () => {
  expect(implementation.parseUpdateDiagnostic).toBeTypeOf('function')
  const input = diagnostic(), result = implementation.parseUpdateDiagnostic(input)
  expect(result).toEqual(input)
  input.relativePath = 'changed'; expect(result?.relativePath).toBe('resources/app.asar')
})

it('rejects unknown fields, unsafe paths, invalid enums and oversized serialized diagnostics', () => {
  expect(implementation.parseUpdateDiagnostic).toBeTypeOf('function')
  for (const changes of [ { token: 'PRIVATE' }, { phase: 'untrusted' }, { nativeCodeSource: 'guessed' }, { nativeErrorCode: -1 },
    { relativePath: '../private.md' }, { relativePath: 'C:/Users/private.md' }, { relativePath: 'resources\\app.asar' },
    { pathScope: 'unknown', relativePath: 'resources/app.asar' }, { ancestorLevelsAboveSession: 2 },
    { primaryStack: '\n'.repeat(4200) }, { origin: 'parent' }, { exceptionType: 'PRIVATE https://secret' } ]) {
    expect(implementation.parseUpdateDiagnostic({ ...diagnostic(), ...changes })).toBeUndefined()
  }
  const hostile = diagnostic(); Object.defineProperty(hostile, 'phase', { get() { throw new Error('PRIVATE') } })
  expect(() => implementation.parseUpdateDiagnostic(hostile)).not.toThrow()
  expect(implementation.parseUpdateDiagnostic(hostile)).toBeUndefined()
})

it('maps parent pin paths to session entries or exact ancestor distance without exposing an absolute path', () => {
  expect(implementation.parentPinDiagnostic).toBeTypeOf('function')
  const failure = (file: string) => Object.assign(new Error('original UI message'), { updateDiagnostic: {
    operation: 'CreateFileW', path: file, directory: false, nativeErrorCode: 32, nativeCodeSource: 'GetLastError',
    access: 2147483648, share: 1, creation: 3, flags: 2097152, validationReason: null } })
  const entry = implementation.parentPinDiagnostic(failure(roots.session + '\\Arkdown.Update.exe'), roots)
  expect(entry).toMatchObject({ origin: 'parent', phase: 'parent.pin', pathScope: 'session', relativePath: 'Arkdown.Update.exe', nativeErrorCode: 32 })
  const ancestor = implementation.parentPinDiagnostic(failure('C:\\Users'), roots)
  expect(ancestor).toMatchObject({ pathScope: 'ancestor', relativePath: null, ancestorLevelsAboveSession: 2 })
  expect(JSON.stringify(ancestor)).not.toContain('synthetic')
  const unknown = implementation.parentPinDiagnostic(failure('D:\\private\\document.md'), roots)
  expect(unknown).toMatchObject({ pathScope: 'unknown', relativePath: null })
  expect(JSON.stringify(unknown)).not.toContain('document.md')
})

it('keeps validation failures code-free and ignores hostile native diagnostic accessors', () => {
  expect(implementation.parentPinDiagnostic).toBeTypeOf('function')
  const error = Object.assign(new Error('validation failed'), { updateDiagnostic: { operation: 'GetFileInformationByHandle',
    path: roots.session, directory: true, nativeErrorCode: null, nativeCodeSource: null, access: 0, share: 7,
    creation: 3, flags: 33554432, validationReason: 'reparse-point' } })
  expect(implementation.parentPinDiagnostic(error, roots)).toMatchObject({ nativeErrorCode: null, nativeCodeSource: null, validationReason: 'reparse-point' })
  Object.defineProperty(error, 'updateDiagnostic', { get() { throw new Error('PRIVATE') } })
  expect(() => implementation.parentPinDiagnostic(error, roots)).not.toThrow()
  expect(implementation.parentPinDiagnostic(error, roots)).toBeUndefined()
})

it('records a generic pin failure without inferring native codes or paths from its message', () => {
  const error = new Error('PRIVATE C:\\Users\\private\\document.md https://secret token=PRIVATE')
  expect(implementation.parentPinDiagnostic(error, roots)).toMatchObject({ origin: 'parent', phase: 'parent.pin',
    operation: null, pathScope: 'unknown', relativePath: null, nativeErrorCode: null, nativeCodeSource: null })
  expect(JSON.stringify(implementation.parentPinDiagnostic(error, roots))).not.toMatch(/PRIVATE|Users|document\.md|secret/)
})

it('retains stack frame identities but removes messages, source paths and arbitrary lines', () => {
  expect(implementation.sanitizeUpdateDiagnostic).toBeTypeOf('function')
  const input = { ...diagnostic(), primaryStack: 'PRIVATE token https://secret\n   at Arkdown.Update.Native.Validate(SafeFileHandle handle) in C:\\Users\\private\\Safety.cs:line 95\n   at pinTrustedUpdateExecutable (C:\\Users\\private\\update-executable.ts:22:9)\nPRIVATE document.md',
    terminalStack: '   at System.IO.FileStream.Dispose(Boolean disposing) in C:\\private.cs:line 30' }
  const safe = implementation.sanitizeUpdateDiagnostic(input)
  expect(safe?.primaryStack).toBe('at Arkdown.Update.Native.Validate\nat pinTrustedUpdateExecutable')
  expect(safe?.terminalStack).toBe('at System.IO.FileStream.Dispose')
  expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|https|Users|Safety\.cs|private\.cs/)
})

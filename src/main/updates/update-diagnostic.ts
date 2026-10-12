import path from 'node:path'

export const UPDATE_DIAGNOSTIC_MAX_CHARACTERS = 8192
const phases = ['parent.pin', 'helper.validate', 'stage.open', 'stage.pin', 'zip.open', 'stage.manifest',
  'stage.extract.entry', 'stage.extract.read', 'stage.extract.write', 'stage.extract.flush', 'stage.extract.entry.dispose',
  'stage.enumerate', 'stage.verify.open', 'stage.verify.content', 'stage.verify.dispose', 'stage.finalize'] as const
const operations = ['CreateFileW', 'GetFileInformationByHandle', 'GetFinalPathNameByHandleW', 'GetFileSizeEx', 'ReadFile',
  'Directory.GetFiles', 'Stream.Read', 'FileStream.Write', 'FileStream.Flush', 'Safety.Verify'] as const
const reasons = ['reparse-point', 'entry-kind', 'hard-link', 'path-too-long', 'path-identity', 'invalid-size', 'short-read'] as const
export interface UpdateDiagnostic {
  schemaVersion: 1
  origin: 'parent' | 'helper'
  phase: typeof phases[number]
  operation: typeof operations[number] | null
  pathScope: 'session' | 'stage' | 'target' | 'package' | 'ancestor' | 'unknown'
  relativePath: string | null
  pathPrecision: 'exact' | 'root-only' | 'unknown'
  ancestorLevelsAboveSession: number | null
  exceptionType: string | null
  nativeErrorCode: number | null
  nativeCodeSource: 'GetLastError' | 'Win32Exception' | 'HResult' | null
  hresult: number | null
  access: number | null
  share: number | null
  creation: number | null
  flags: number | null
  validationReason: typeof reasons[number] | null
  primaryStack: string | null
  terminalStack: string | null
}
export interface UpdateDiagnosticRoots { session: string; stage: string; target: string; package: string }
const keys = ['schemaVersion', 'origin', 'phase', 'operation', 'pathScope', 'relativePath', 'pathPrecision',
  'ancestorLevelsAboveSession', 'exceptionType', 'nativeErrorCode', 'nativeCodeSource', 'hresult', 'access', 'share',
  'creation', 'flags', 'validationReason', 'primaryStack', 'terminalStack'] as const
const member = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value)
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const nullableUint = (value: unknown) => value === null || integer(value, 0, 0xffffffff)
const relative = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
  && !/[\\:<>"|?*\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')

/** Only fixed data properties are copied; a diagnostic cannot execute getters/toJSON or modify its UI error. */
export function parseUpdateDiagnostic(value: unknown, origin: 'helper' | 'parent' = 'helper'): UpdateDiagnostic | undefined {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.keys(descriptors).length !== keys.length || !keys.every(key => descriptors[key] && 'value' in descriptors[key])) return
    const input = Object.fromEntries(keys.map(key => [key, descriptors[key].value])) as unknown as UpdateDiagnostic
    if (input.schemaVersion !== 1 || input.origin !== origin || !member(input.phase, phases)
      || (origin === 'parent') !== (input.phase === 'parent.pin')
      || !(input.operation === null || member(input.operation, operations))
      || !member(input.pathScope, ['session', 'stage', 'target', 'package', 'ancestor', 'unknown'])
      || !member(input.pathPrecision, ['exact', 'root-only', 'unknown'])
      || !(input.exceptionType === null || typeof input.exceptionType === 'string' && /^[A-Za-z_][A-Za-z0-9_.$+`]{0,159}$/.test(input.exceptionType))
      || !nullableUint(input.nativeErrorCode) || !nullableUint(input.access) || !nullableUint(input.share)
      || !nullableUint(input.creation) || !nullableUint(input.flags)
      || !(input.hresult === null || integer(input.hresult, -0x80000000, 0x7fffffff))
      || !(input.nativeCodeSource === null || member(input.nativeCodeSource, ['GetLastError', 'Win32Exception', 'HResult']))
      || (input.nativeErrorCode === null) !== (input.nativeCodeSource === null)
      || !(input.validationReason === null || member(input.validationReason, reasons))
      || ![input.primaryStack, input.terminalStack].every(stack => stack === null || typeof stack === 'string' && stack.length <= UPDATE_DIAGNOSTIC_MAX_CHARACTERS)) return
    if (input.pathScope === 'ancestor') {
      if (!integer(input.ancestorLevelsAboveSession, 1, 128) || input.relativePath !== null || input.pathPrecision !== 'exact') return
    } else {
      if (input.ancestorLevelsAboveSession !== null) return
      if (input.pathPrecision === 'exact' ? !relative(input.relativePath) : input.relativePath !== null) return
      if (input.pathScope === 'unknown' && input.pathPrecision !== 'unknown') return
    }
    if (JSON.stringify(input).length > UPDATE_DIAGNOSTIC_MAX_CHARACTERS) return
    return input
  } catch { return undefined }
}

/** Preserve frame identities only: stack messages, source paths and argument values are not diagnostic fields. */
function stackFrames(value: string | null): string | null {
  if (value === null) return null
  const frames = value.split(/\r?\n/).flatMap(line => {
    const match = /^\s*at ([A-Za-z_$][A-Za-z0-9_.$+<>`]*)(?=\s|\(|$)/.exec(line)
    return match ? [`at ${match[1]}`] : []
  })
  return frames.length ? frames.join('\n') : null
}
export function sanitizeUpdateDiagnostic(value: unknown, origin: 'helper' | 'parent' = 'helper'): UpdateDiagnostic | undefined {
  const snapshot = parseUpdateDiagnostic(value, origin)
  return snapshot && { ...snapshot, primaryStack: stackFrames(snapshot.primaryStack), terminalStack: stackFrames(snapshot.terminalStack) }
}

function pathIdentity(file: unknown, roots: UpdateDiagnosticRoots): Pick<UpdateDiagnostic, 'pathScope' | 'pathPrecision' | 'relativePath' | 'ancestorLevelsAboveSession'> {
  const unknown = { pathScope: 'unknown', pathPrecision: 'unknown', relativePath: null, ancestorLevelsAboveSession: null } as const
  if (typeof file !== 'string' || file.length > 32760 || !path.win32.isAbsolute(file)) return unknown
  const normalized = path.win32.normalize(file.replace(/^\\\\\?\\/, ''))
  for (const scope of ['package', 'stage', 'session', 'target'] as const) {
    const root = path.win32.normalize(roots[scope]), rel = path.win32.relative(root, normalized).replaceAll('\\', '/')
    if (!rel) return { ...unknown, pathScope: scope, pathPrecision: 'root-only' }
    if (scope !== 'package' && relative(rel)) return { ...unknown, pathScope: scope, pathPrecision: 'exact', relativePath: rel }
  }
  const ancestor = path.win32.relative(path.win32.normalize(roots.session), normalized).split('\\')
  if (ancestor.length <= 128 && ancestor.every(part => part === '..')) return {
    ...unknown, pathScope: 'ancestor', pathPrecision: 'exact', ancestorLevelsAboveSession: ancestor.length,
  }
  return unknown
}

/** Called only inside the existing pin failure catch; never reads native last-error state. */
export function parentPinDiagnostic(error: unknown, roots: UpdateDiagnosticRoots): UpdateDiagnostic | undefined {
  try {
    if (!error || typeof error !== 'object') return
    const native = Object.getOwnPropertyDescriptor(error, 'updateDiagnostic')
    if (native && (!('value' in native) || !native.value || typeof native.value !== 'object')) return
    const descriptors = native ? Object.getOwnPropertyDescriptors(native.value) : {}
    const take = (key: string): unknown => native ? descriptors[key] && 'value' in descriptors[key] ? descriptors[key].value : undefined : null
    const stack = Object.getOwnPropertyDescriptor(error, 'stack')
    return sanitizeUpdateDiagnostic({ schemaVersion: 1, origin: 'parent', phase: 'parent.pin',
      operation: take('operation'), ...pathIdentity(take('path'), roots), exceptionType: 'Error',
      nativeErrorCode: take('nativeErrorCode'), nativeCodeSource: take('nativeCodeSource'), hresult: null,
      access: take('access'), share: take('share'), creation: take('creation'), flags: take('flags'),
      validationReason: take('validationReason'), primaryStack: stack && 'value' in stack && typeof stack.value === 'string' ? stack.value : null, terminalStack: null }, 'parent')
  } catch { return undefined }
}

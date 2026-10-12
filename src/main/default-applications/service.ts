import path from 'node:path'
import { release } from 'node:os'
import { PublicError } from '../../shared/public-errors'
import { DEFAULT_APPLICATION_CANDIDATES } from '../../shared/default-application-registration'
import type { DefaultApplicationsStatus } from '../../shared/default-applications'
import { canInitializeDesktopRegistration, registryValue, sameRegistryValue, WindowsShellRegistry, type RegistryBoundary, type RegistryValue } from '../shell-integration/windows-registry'

const string = (data: string): RegistryValue => ({ kind: 'String', data })
export const MARKDOWN_PROG_ID = 'Arkdown.Document.Markdown'
export const TEXT_PROG_ID = 'Arkdown.Document.Text'
export const DOCX_PROG_ID = 'Arkdown.Document.Docx'
export const OTHER_MARKDOWN_PROG_ID = 'Arkdown.Document.OtherMarkdown'
const candidates = DEFAULT_APPLICATION_CANDIDATES

function registeredExecutable(value: RegistryValue | null, suffix: string): string | null {
  if (value?.kind !== 'String' || typeof value.data !== 'string') return null
  const match = /^"([^"\r\n\0]+)"(.*)$/.exec(value.data)
  return match && match[2] === suffix && path.win32.isAbsolute(match[1])
    && path.win32.basename(match[1]).toLowerCase() === 'arkdown.exe' ? match[1] : null
}

/** Dedicated, non-disposable candidates. No extension default or UserChoice writes. */
export async function registerDefaultApplications(registry: RegistryBoundary, executable: string,
  iconDirectory = path.win32.join(path.win32.dirname(executable), 'resources', 'branding'),
  options: { explicitEnable?: boolean } = {}): Promise<void> {
  if (!path.win32.isAbsolute(executable) || /["\r\n\0]/.test(executable)) throw new PublicError('INVALID_INPUT')
  if (!path.win32.isAbsolute(iconDirectory) || /["\r\n\0]/.test(iconDirectory)) throw new PublicError('INVALID_INPUT')
  const plan = [
    ...candidates.flatMap(([key, description, icon]) => [
      { key, name: '', value: string(description) },
      { key: `${key}\\DefaultIcon`, name: '', value: string(`"${path.win32.join(iconDirectory, icon)}",0`) },
      { key: `${key}\\shell\\open\\command`, name: '', value: string(`"${executable}" "%1"`) },
    ]),
    { key: '@Capabilities', name: 'ApplicationName', value: string('Arkdown') },
    { key: '@Capabilities', name: 'ApplicationDescription', value: string('Markdown 和文本文档编辑器') },
    { key: '@Capabilities', name: 'ApplicationIcon', value: string(`"${executable}",0`) },
    ...candidates.flatMap(([key, , , extensions]) => extensions.map((extension) => ({
      key: '@Capabilities\\FileAssociations', name: `.${extension}`, value: string(key),
    }))),
    { key: '@RegisteredApplications', name: 'Arkdown', value: string('Software\\Arkdown\\Capabilities') },
  ]
  const changed: (typeof plan[number] & { before: RegistryValue | null })[] = [], created: string[] = []
  const keys = new Set(plan.flatMap((entry) => entry.key.split('\\').map((_, i, parts) => parts.slice(0, i + 1).join('\\'))))
  const assertCandidateKeys = async () => {
    for (const key of keys) {
      const current = await registry.read(key)
      if (key !== '@RegisteredApplications' && current && (Object.keys(current.values).some((name) =>
        !plan.some((entry) => entry.key === key && entry.name.toLowerCase() === name.toLowerCase()))
        || current.subkeys.some((subkey) => ![...keys].some((candidate) => candidate.toLowerCase() === `${key}\\${subkey}`.toLowerCase())))) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
    }
  }
  // Uninstall leaves empty keys to avoid racing another writer while pruning.
  // Only the already-validated known structure, with no values at all, is reusable.
  const isEmptyRegistration = async (prefix: string) => {
    for (const key of keys) {
      if (key === prefix || key.startsWith(`${prefix}\\`)) {
        const current = await registry.read(key)
        if (current && Object.keys(current.values).length) return false
      }
    }
    return true
  }
  try {
    await assertCandidateKeys()
    // Only an explicit request may replace a recognized older Arkdown path.
    // Keep background refresh strict so opening an old portable copy cannot take over.
    const replaceable = new Map<string, RegistryValue>()
    for (const [progId, , icon] of candidates) {
      const key = await registry.read(progId)
      if (!key) continue
      const commandKey = `${progId}\\shell\\open\\command`
      const command = registryValue(await registry.read(commandKey), '')
      if (!command && await isEmptyRegistration(progId)) continue
      const previous = registeredExecutable(command, ' "%1"')
      const currentCopy = sameRegistryValue(command, string(`"${executable}" "%1"`))
      if (!currentCopy && !(options.explicitEnable && previous)) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
      if (command) replaceable.set(commandKey, command)
      const previousExe = currentCopy ? executable : previous!
      const iconKey = `${progId}\\DefaultIcon`
      const previousIcon = registryValue(await registry.read(iconKey), '')
      if (sameRegistryValue(previousIcon, string(`"${previousExe}",0`))
        || (options.explicitEnable && sameRegistryValue(previousIcon,
          string(`"${path.win32.join(path.win32.dirname(previousExe), 'resources', 'branding', icon)}",0`)))) {
        replaceable.set(iconKey, previousIcon!)
      }
    }
    const capabilities = await registry.read('@Capabilities')
    const applicationIcon = registryValue(capabilities, 'ApplicationIcon')
    if (capabilities && !sameRegistryValue(applicationIcon, string(`"${executable}",0`))
      && !(options.explicitEnable && registeredExecutable(applicationIcon, ',0'))
      && !(await isEmptyRegistration('@Capabilities'))) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
    // Preflight every key, including intervening ProgID parents; foreign handlers are conflicts.
    await assertCandidateKeys()
    const pending: typeof changed = []
    for (const entry of plan) {
      const current = registryValue(await registry.read(entry.key), entry.name)
      const previous = entry.key === '@Capabilities' && entry.name === 'ApplicationIcon'
        ? applicationIcon : replaceable.get(entry.key) ?? null
      if (current && !sameRegistryValue(current, entry.value) && !sameRegistryValue(current, previous)) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
      if (!sameRegistryValue(current, entry.value)) {
        // Validate the effective HKCR registration, but CAS/rollback only our HKCU layer.
        const before = registryValue(await registry.read(entry.key, 'user'), entry.name)
        if (before && !sameRegistryValue(before, current)) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
        pending.push({ ...entry, before })
      }
    }
    for (const entry of pending) {
      created.push(...await registry.change(entry.key, entry.name, entry.before, entry.value))
      changed.push(entry)
    }
    // Revalidate before declaring registration complete.
    for (const entry of plan) if (!sameRegistryValue(registryValue(await registry.read(entry.key), entry.name), entry.value)) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
    await assertCandidateKeys()
    if (changed.length) await registry.notify()
  } catch (error) {
    let incomplete = false
    for (const entry of changed.reverse()) {
      try { await registry.change(entry.key, entry.name, entry.value, entry.before) } catch { incomplete = true }
    }
    for (const key of [...new Set(created)].sort((a, b) => b.length - a.length)) {
      try { await registry.removeEmpty(key) } catch { incomplete = true }
    }
    if (incomplete) throw new PublicError('SHELL_INTEGRATION_ROLLBACK_INCOMPLETE')
    throw error
  } finally { await registry.close?.() }
}

const associationBackupKey = '@DefaultApplicationsState'
function readAssociationBackup(value: RegistryValue | null): { previous: RegistryValue | null } | null {
  if (!value) return null
  try {
    if (value.kind !== 'String' || typeof value.data !== 'string') throw new Error()
    const parsed = JSON.parse(value.data)
    if (parsed?.version !== 1 || !Object.hasOwn(parsed, 'previous') || (parsed.previous !== null
      && (parsed.previous?.kind !== 'String' || typeof parsed.previous.data !== 'string'))) throw new Error()
    return { previous: parsed.previous }
  } catch { throw new PublicError('DEFAULT_APPLICATIONS_CONFLICT') }
}

/** Use ordinary per-user extension registration only where no explicit UserChoice exists. */
export async function enableDefaultApplications(registry: RegistryBoundary, executable: string, iconDirectory?: string): Promise<void> {
  await registerDefaultApplications(registry, executable, iconDirectory, { explicitEnable: true })
  const changed: { key: string; name: string; before: RegistryValue | null; after: RegistryValue }[] = []
  try {
    for (const [extension, progId] of [['.md', MARKDOWN_PROG_ID], ['.txt', TEXT_PROG_ID]] as const) {
      if (await registry.userChoice(extension)) continue
      const before = registryValue(await registry.read(extension, 'user'), '')
      if (sameRegistryValue(before, string(progId))) continue
      if (before && (before.kind !== 'String' || typeof before.data !== 'string')) throw new PublicError('DEFAULT_APPLICATIONS_CONFLICT')
      const backup = registryValue(await registry.read(associationBackupKey, 'user'), extension)
      readAssociationBackup(backup)
      const after = string(JSON.stringify({ version: 1, previous: before }))
      await registry.change(associationBackupKey, extension, backup, after)
      changed.push({ key: associationBackupKey, name: extension, before: backup, after })
      // A new explicit choice wins even if it appeared while registering.
      if (await registry.userChoice(extension)) continue
      await registry.change(extension, '', before, string(progId))
      changed.push({ key: extension, name: '', before, after: string(progId) })
    }
  } catch (error) {
    let incomplete = false
    for (const entry of changed.reverse()) {
      try { await registry.change(entry.key, entry.name, entry.after, entry.before) } catch { incomplete = true }
    }
    if (incomplete) throw new PublicError('DEFAULT_APPLICATIONS_ROLLBACK_INCOMPLETE')
    throw error
  } finally { try { await registry.notify() } finally { await registry.close?.() } }
}

/** Detach md/txt only. Keep shared ProgIDs valid for .text and existing references. */
export async function unregisterDefaultApplications(registry: RegistryBoundary, executable: string): Promise<void> {
  if (!path.win32.isAbsolute(executable) || /["\r\n\0]/.test(executable)) throw new PublicError('INVALID_INPUT')
  const changed: { key: string; name: string; before: RegistryValue; after: RegistryValue | null }[] = []
  try {
    const pending: { extension: '.md' | '.txt'; progId: string; backupValue: RegistryValue | null; backup: ReturnType<typeof readAssociationBackup> }[] = []
    for (const [extension, progId] of [['.md', MARKDOWN_PROG_ID], ['.txt', TEXT_PROG_ID]] as const) {
      const command = await registry.read(`${progId}\\shell\\open\\command`)
      if (!sameRegistryValue(registryValue(command, ''), string(`"${executable}" "%1"`))) continue
      if (command!.subkeys.length || Object.keys(command!.values).some(name => name !== '')) throw new PublicError('SHELL_INTEGRATION_CONFLICT')
      const root = await registry.read(progId), shell = await registry.read(`${progId}\\shell`), open = await registry.read(`${progId}\\shell\\open`)
      const verb = registryValue(shell, '')
      if (root?.subkeys.some(name => ['curver', 'clsid'].includes(name.toLowerCase()))
        || !open || Object.keys(open.values).length || open.subkeys.length !== 1 || open.subkeys[0].toLowerCase() !== 'command'
        || (verb && (verb.kind !== 'String' || typeof verb.data !== 'string' || (verb.data !== '' && verb.data.toLowerCase() !== 'open')))) {
        throw new PublicError('SHELL_INTEGRATION_CONFLICT')
      }
      const backupValue = registryValue(await registry.read(associationBackupKey, 'user'), extension)
      const backup = readAssociationBackup(backupValue)
      pending.push({ extension, progId, backupValue, backup })
    }
    // A damaged/redirected second format must fail before releasing the first
    // UserChoice: Windows choices cannot be recreated by our value rollback.
    for (const { extension, progId, backupValue, backup } of pending) {
      if (!registry.releaseOwnedDefault) throw new PublicError('DEFAULT_APPLICATIONS_RELEASE_FAILED')
      // Windows may refuse release. Never delete the live handler in that case.
      await registry.releaseOwnedDefault(extension, progId, executable)
      for (const [key, name, expected] of [
        [extension, '', string(progId)],
        ['@Capabilities\\FileAssociations', extension, string(progId)],
      ] as const) {
        const before = registryValue(await registry.read(key, 'user'), name)
        if (before && sameRegistryValue(before, expected)) {
          const after = key === extension ? backup?.previous ?? null : null
          await registry.change(key, name, before, after)
          changed.push({ key, name, before, after })
        }
      }
      const key = `${extension}\\OpenWithProgids`
      const before = registryValue(await registry.read(key, 'user'), progId)
      if (before && ((before.kind === 'String' && before.data === '')
        || (['None', 'Binary'].includes(before.kind) && Array.isArray(before.data) && before.data.length === 0))) {
        await registry.change(key, progId, before, null)
        changed.push({ key, name: progId, before, after: null })
      }
      if (backupValue) {
        await registry.change(associationBackupKey, extension, backupValue, null)
        changed.push({ key: associationBackupKey, name: extension, before: backupValue, after: null })
      }
    }
    // Leave empty extension keys in place: other software may concurrently use them.
  } catch (error) {
    for (const entry of changed.reverse()) {
      try { await registry.change(entry.key, entry.name, entry.after, entry.before) } catch { /* Do not overwrite a concurrent choice. */ }
    }
    throw error
  } finally {
    try { await registry.notify() } finally { await registry.close?.() }
  }
}

export class DefaultApplicationsService {
  private tail = Promise.resolve()
  private readonly queries = new Set<Promise<DefaultApplicationsStatus>>()
  constructor(private readonly actions: { query(): Promise<DefaultApplicationsStatus>; register(): Promise<void>; enable?(): Promise<void>; unregister?(): Promise<void>; open(): Promise<void>; refresh?(): Promise<void> }) {}
  getStatus() {
    const query = this.tail.then(() => this.actions.query())
    this.queries.add(query)
    void query.then(() => this.queries.delete(query), () => this.queries.delete(query))
    return query
  }
  async drain(): Promise<void> { await Promise.allSettled([this.tail, ...this.queries]) }
  setEnabled(enabled: boolean): Promise<DefaultApplicationsStatus> {
    const operation = this.tail.then(async () => {
      try {
        if (enabled) await (this.actions.enable ?? this.actions.register)()
        else {
          if (!this.actions.unregister) throw new PublicError('DEFAULT_APPLICATIONS_RELEASE_FAILED')
          await this.actions.unregister()
        }
      } catch (error) {
        if (error instanceof PublicError && error.code === 'SHELL_INTEGRATION_CONFLICT') throw new PublicError('DEFAULT_APPLICATIONS_CONFLICT')
        if (error instanceof PublicError && error.code === 'SHELL_INTEGRATION_ROLLBACK_INCOMPLETE') throw new PublicError('DEFAULT_APPLICATIONS_ROLLBACK_INCOMPLETE')
        if (!enabled) throw new PublicError('DEFAULT_APPLICATIONS_RELEASE_FAILED')
        throw error
      }
      return this.actions.query()
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
  refreshOwnedRegistration(): Promise<void> {
    const operation = this.tail.then(() => this.actions.refresh?.())
    this.tail = operation.catch(() => undefined)
    return operation
  }
  openSettings(): Promise<void> {
    const operation = this.tail.then(async () => {
      try { await this.actions.register() } catch (error) {
        if (error instanceof PublicError && error.code === 'SHELL_INTEGRATION_CONFLICT') throw new PublicError('DEFAULT_APPLICATIONS_CONFLICT')
        if (error instanceof PublicError && error.code === 'SHELL_INTEGRATION_ROLLBACK_INCOMPLETE') throw new PublicError('DEFAULT_APPLICATIONS_ROLLBACK_INCOMPLETE')
        throw error
      }
      try { await this.actions.open() } catch { throw new PublicError('DEFAULT_APPLICATIONS_UNSUPPORTED') }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
}

export function defaultApplicationsSettingsUri(osRelease: string): string {
  // 21H2/22H2 need an April 2023 cumulative update, whose revision os.release
  // does not expose. Use the general page unless support is known from the build.
  return Number(osRelease.split('.')[2]) >= 22631
    ? 'ms-settings:defaultapps?registeredAppUser=Arkdown' : 'ms-settings:defaultapps'
}

export async function refreshOwnedDefaultApplications(registry: RegistryBoundary, executable: string, iconDirectory?: string) {
  try {
    const associations = await registry.read('@Capabilities\\FileAssociations')
    // Explicit md/txt removal must survive the next startup. Other formats remain registered.
    if (associations && !registryValue(associations, '.md') && !registryValue(associations, '.txt')) return
    let owned = false
    for (const [key] of candidates) {
      if (sameRegistryValue(registryValue(await registry.read(`${key}\\shell\\open\\command`), ''), string(`"${executable}" "%1"`))) owned = true
    }
    if (!owned) return
    await registerDefaultApplications(registry, executable, iconDirectory)
  } finally { await registry.close?.() }
}

export function createWindowsDefaultApplications(executable: string, openExternal: (uri: string) => Promise<void>, iconDirectory?: string) {
  return new DefaultApplicationsService({
    query: async () => {
      const registry = new WindowsShellRegistry()
      try { return await registry.defaultApplicationsStatus(executable) } finally { await registry.close() }
    },
    register: () => registerDefaultApplications(new WindowsShellRegistry(), executable, iconDirectory, { explicitEnable: true }),
    enable: () => enableDefaultApplications(new WindowsShellRegistry(), executable, iconDirectory),
    unregister: () => unregisterDefaultApplications(new WindowsShellRegistry(), executable),
    refresh: () => refreshOwnedDefaultApplications(new WindowsShellRegistry(), executable, iconDirectory),
    open: async () => {
      if (process.platform !== 'win32' || !canInitializeDesktopRegistration()) throw new PublicError('DEFAULT_APPLICATIONS_UNSUPPORTED')
      await openExternal(defaultApplicationsSettingsUri(release()))
    },
  })
}

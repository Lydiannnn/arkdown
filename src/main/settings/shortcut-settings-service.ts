import {
  applyShortcutUpdate, normalizeShortcutBindings, shortcutFor, SHORTCUT_DEFINITIONS, parseObservedShortcutUpdate,
  type ShortcutSnapshot, type ShortcutUpdate, type ShortcutUpdateResult, type ShortcutBindings,
  type ObservedShortcutSnapshot, type ObservedShortcutUpdate, type ObservedShortcutUpdateResult,
} from '../../shared/keyboard-shortcuts'
import type { SettingsUpdater } from './settings-coordinator'
import type { ScreenshotShortcutRegistration } from '../screenshot-translation/screenshot-shortcut'
import type { SettingsAuthority } from './settings-authority'
import type { SettingsTransactionSnapshot, ShortcutFieldChange } from './settings-transaction-types'

export interface ShortcutSettingsDependencies {
  settings: SettingsUpdater | { authority: Pick<SettingsAuthority, 'readFresh' | 'getDisplaySnapshot' | 'apply'> }
  screenshot: ScreenshotShortcutRegistration
  additionalGlobals?: readonly { id: string; registration: ScreenshotShortcutRegistration }[]
  broadcast(snapshot: ShortcutSnapshot): void
  refreshMenus(): void
}

export class ShortcutSettingsService {
  private revision = 0
  private tail = Promise.resolve()
  private recordingOwners = new Set<number>()
  private changingGlobals = false
  constructor(private readonly dependencies: ShortcutSettingsDependencies) {}

  get(): ShortcutSnapshot {
    const settings = this.dependencies.settings
    return 'authority' in settings ? this.observe(settings.authority.getDisplaySnapshot())
      : { bindings: normalizeShortcutBindings(settings.get().shortcuts), revision: this.revision }
  }

  update(update: ShortcutUpdate): Promise<ShortcutUpdateResult> {
    const settings = this.dependencies.settings
    if ('authority' in settings) return Promise.reject(new Error('SHORTCUT_LEGACY_WRITER_DISABLED'))
    const operation = this.tail.then(async (): Promise<ShortcutUpdateResult> => {
      let bindings
      try { bindings = applyShortcutUpdate(this.get().bindings, update) }
      catch (error) { return { snapshot: this.get(), error: (error as Error).message } }
      try {
        const persist = () => settings.update(current => ({ ...current, shortcuts: bindings }))
        const applied = await this.applyGlobals(this.get().bindings, bindings, update, persist)
        if (!applied) return { snapshot: this.get(), error: '系统无法注册快捷键，原绑定已保留。请选择其他组合。' }
      } catch {
        return { snapshot: this.get(), error: '快捷键保存失败，原绑定已保留，请重试。' }
      }
      this.revision += 1
      const snapshot = this.get()
      this.dependencies.refreshMenus()
      this.dependencies.broadcast(snapshot)
      return { snapshot, error: null }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  readObserved(): Promise<ObservedShortcutSnapshot> {
    const settings = this.dependencies.settings
    if (!('authority' in settings)) return Promise.reject(new Error('SHORTCUT_AUTHORITY_UNAVAILABLE'))
    return settings.authority.readFresh().then(snapshot => this.observe(snapshot))
  }

  updateObserved(input: ObservedShortcutUpdate): Promise<ObservedShortcutUpdateResult> {
    const settings = this.dependencies.settings, submitted = parseObservedShortcutUpdate(input)
    if (!('authority' in settings)) return Promise.reject(new Error('SHORTCUT_AUTHORITY_UNAVAILABLE'))
    if (!submitted) return Promise.reject(new Error('SHORTCUT_COMMAND_INVALID'))
    const { authority } = settings
    const operation = this.tail.then(async (): Promise<ObservedShortcutUpdateResult> => {
      const { observed, change } = submitted
      const ids = 'resetAll' in change ? SHORTCUT_DEFINITIONS.map(item => item.id) : [change.id]
      const checked: Record<string, ShortcutFieldChange> = Object.fromEntries(ids.map(id => {
        const value = observed.bindings[id]
        const expected = { value, revision: observed.observation.fields[id] ?? 0 }
        return [id, value === undefined ? { kind: 'clear', expected } : { kind: 'set', value, expected }]
      }))
      const baseRevision = observed.revision
      const guard = await authority.apply({ baseRevision, operations: [{ kind: 'shortcuts.patch', changes: checked }] })
      if (guard.status === 'invalid') throw new Error('SHORTCUT_COMMAND_INVALID')
      const conflictMessage = '快捷键已在其他窗口更改。你的选择仍保留，请重新加载后再调整。'
      if (guard.status === 'conflict') return { snapshot: this.observe(guard.snapshot), error: conflictMessage }
      const before = normalizeShortcutBindings(guard.snapshot.settings.shortcuts)
      let bindings: ShortcutBindings
      try { bindings = applyShortcutUpdate(before, change) }
      catch (error) { return { snapshot: this.observe(guard.snapshot), error: (error as Error).message } }
      const changes: Record<string, ShortcutFieldChange> = Object.fromEntries(ids.map(id => [id,
        !Object.hasOwn(bindings, id) ? { kind: 'clear', expected: checked[id]!.expected }
          : { kind: 'set', value: bindings[id], expected: checked[id]!.expected }]))
      let committed: SettingsTransactionSnapshot | undefined
      let failureSnapshot = guard.snapshot
      try {
        const applied = await this.applyGlobals(before, bindings, change, async () => {
          const result = await authority.apply({ baseRevision, operations: [{ kind: 'shortcuts.patch', changes }] })
          if (result.status === 'invalid') throw new Error('快捷键组合已失效，请重新加载后再调整。')
          failureSnapshot = result.snapshot
          if (result.status === 'conflict') throw new Error(conflictMessage)
          committed = result.snapshot
        })
        if (!applied && !committed) return { snapshot: this.observe(failureSnapshot), error: '系统无法注册快捷键，原绑定已保留。请选择其他组合。' }
      } catch (error) {
        if (!committed) return { snapshot: this.observe(failureSnapshot), error: error instanceof Error ? error.message : '快捷键保存失败，请重试。' }
      }
      if (!committed) throw new Error('SHORTCUT_PERSIST_CALLBACK_MISSING')
      const snapshot = this.observe(committed)
      try { this.dependencies.refreshMenus() } catch { /* Saved values remain acknowledged. */ }
      try { this.dependencies.broadcast(snapshot) } catch { /* Focus refresh recovers missed presentation. */ }
      return { snapshot, error: null }
    })
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private observe(snapshot: SettingsTransactionSnapshot): ObservedShortcutSnapshot {
    return { bindings: normalizeShortcutBindings(snapshot.settings.shortcuts), revision: snapshot.revision,
      observation: { version: 1, minimumBaseRevision: snapshot.minimumBaseRevision,
        fields: Object.fromEntries(SHORTCUT_DEFINITIONS.filter(item => Object.hasOwn(snapshot.fieldRevisions.fields, `shortcuts.${item.id}`))
          .map(item => [item.id, snapshot.fieldRevisions.fields[`shortcuts.${item.id}`]])) } }
  }

  private async applyGlobals(before: ShortcutBindings, bindings: ShortcutBindings, update: ShortcutUpdate, persist: () => Promise<void>): Promise<boolean> {
    const allGlobals = [{ id: 'tools.screenshot-translation', registration: this.dependencies.screenshot },
      ...(this.dependencies.additionalGlobals ?? [])]
    const globals = allGlobals.filter(item => shortcutFor(item.id, bindings) !== shortcutFor(item.id, before)
      || ('id' in update && update.id === item.id) || 'resetAll' in update)
    const conflict = new Error('GLOBAL_REGISTRATION_CONFLICT')
    const apply = async (index: number): Promise<void> => {
      const item = globals[index]
      if (!item) { await persist(); return }
      if (!await item.registration.replace(shortcutFor(item.id, bindings), () => apply(index + 1))) throw conflict
    }
    this.changingGlobals = globals.length > 0
    try {
      // Release the whole changed set before reserving replacements, including key exchanges.
      for (const item of globals) if (!item.registration.suspend()) throw conflict
      await apply(0)
      return true
    } catch (error) { if (error === conflict) return false; throw error }
    finally {
      this.changingGlobals = false
      if (globals.length > 0 && this.recordingOwners.size === 0) for (const item of allGlobals) item.registration.resume()
    }
  }

  isRecording(ownerId: number): boolean { return this.recordingOwners.has(ownerId) }

  setRecording(ownerId: number, active: boolean): void {
    const registrations = [this.dependencies.screenshot, ...(this.dependencies.additionalGlobals ?? []).map(item => item.registration)]
    if (active) {
      if (this.recordingOwners.has(ownerId)) return
      if (this.recordingOwners.size === 0) {
        const suspended: ScreenshotShortcutRegistration[] = []
        for (const registration of registrations) {
          if (!registration.suspend()) { suspended.forEach(item => item.resume()); throw new Error('无法暂停全局快捷键，请重试。') }
          suspended.push(registration)
        }
      }
      this.recordingOwners.add(ownerId)
    } else {
      if (!this.recordingOwners.has(ownerId)) return
      this.recordingOwners.delete(ownerId)
      if (this.recordingOwners.size === 0 && !this.changingGlobals) {
        const resumed = registrations.map(registration => registration.resume())
        if (resumed.some(value => !value)) throw new Error('全局快捷键暂时无法恢复，请重试。')
      }
    }
  }

  releaseOwner(ownerId: number): void {
    this.recordingOwners.delete(ownerId)
    if (this.recordingOwners.size === 0 && !this.changingGlobals) {
      this.dependencies.screenshot.resume()
      this.dependencies.additionalGlobals?.forEach(item => item.registration.resume())
    }
  }
}

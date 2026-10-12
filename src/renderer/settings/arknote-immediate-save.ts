import { arknotePreferencesForUpdate, copyArknotePreferences, ARKNOTE_MATERIAL_PREFERENCE_KEYS,
  type ArknotePreferences, type ArknotePreferencesUpdate } from '../../shared/arknote-preferences'

export interface ArknoteImmediateSaveState { value: ArknotePreferences; pending: boolean; error: string | null }

/** One in-flight write, coalesced latest draft, and retryable failed changes. */
export class ArknoteImmediateSave {
  private value: ArknotePreferences
  private revision = 0
  private savedRevision = 0
  private running?: Promise<boolean>
  private readonly dirtyMaterials = new Set<typeof ARKNOTE_MATERIAL_PREFERENCE_KEYS[number]>()
  constructor(initial: ArknotePreferences,
    private readonly persist: (input: ArknotePreferencesUpdate) => Promise<ArknotePreferences>,
    private readonly notify: (state: ArknoteImmediateSaveState) => void) {
    this.value = copyArknotePreferences(initial)
  }
  change(patch: Partial<ArknotePreferences>): void {
    this.value = copyArknotePreferences({ ...this.value, ...patch })
    this.revision += 1
    for (const key of ARKNOTE_MATERIAL_PREFERENCE_KEYS) if (Object.hasOwn(patch, key)) this.dirtyMaterials.add(key)
    this.notify({ value: copyArknotePreferences(this.value), pending: true, error: null })
    void this.flush()
  }
  flush(): Promise<boolean> {
    if (this.running) return this.running
    const operation = this.drain()
    this.running = operation
    void operation.finally(() => { if (this.running === operation) this.running = undefined })
    return operation
  }
  private async drain(): Promise<boolean> {
    while (this.savedRevision < this.revision) {
      const revision = this.revision
      const value = copyArknotePreferences(this.value)
      const materialPatch: Partial<ArknotePreferences> = {}
      for (const key of this.dirtyMaterials) Object.assign(materialPatch, { [key]: value[key] })
      this.notify({ value: copyArknotePreferences(this.value), pending: true, error: null })
      try {
        const saved = await this.persist(arknotePreferencesForUpdate(value, materialPatch))
        this.savedRevision = revision
        if (revision === this.revision) {
          this.value = copyArknotePreferences(saved)
          this.dirtyMaterials.clear()
        }
      } catch {
        this.notify({ value: copyArknotePreferences(this.value), pending: false, error: '设置未能保存，请重试；关闭前会再次保存。' })
        return false
      }
    }
    this.notify({ value: copyArknotePreferences(this.value), pending: false, error: null })
    return true
  }
}

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { DEFAULT_SCREEN_TRANSLATION, parseScreenTranslationPatch, type ScreenTranslationPreferences } from '../../shared/screen-translation'

export class ScreenTranslationSettingsStore {
  private current: ScreenTranslationPreferences = { ...DEFAULT_SCREEN_TRANSLATION }
  private tail = Promise.resolve()
  constructor(readonly directory: string) {}
  get(): ScreenTranslationPreferences { return { ...this.current, ...(this.current.bounds ? { bounds: { ...this.current.bounds } } : {}) } }
  async load(): Promise<void> {
    try { await this.reload() }
    catch { /* Startup remains tolerant of old malformed module preferences. */ }
  }
  /** Explicit discard requires a confirmed disk state; failed reads leave the cache intact. */
  reload(): Promise<void> {
    const operation = this.tail.then(async () => {
      let bytes: Buffer
      try { bytes = await readFile(path.join(this.directory, 'settings.json')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.current = { ...DEFAULT_SCREEN_TRANSLATION }
          return
        }
        throw new Error('无法重新载入翻译设置，请检查目录权限后重试。')
      }
      try {
        if (bytes.length > 16_384) throw new Error('oversized')
        const value = parseScreenTranslationPatch(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')))
        if (!value) throw new Error('invalid')
        this.current = { ...DEFAULT_SCREEN_TRANSLATION, ...value }
      } catch { throw new Error('翻译设置文件无效，未保存的修改已保留。') }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
  update(patch: Partial<ScreenTranslationPreferences>): Promise<void> {
    const operation = this.tail.then(async () => {
      const parsed = parseScreenTranslationPatch(patch)
      if (!parsed) throw new Error('悬浮翻译窗设置无效。')
      const next = { ...this.current, ...parsed }
      await mkdir(this.directory, { recursive: true })
      await writeFileAtomic(path.join(this.directory, 'settings.json'), JSON.stringify(next, null, 2), { encoding: 'utf8' })
      this.current = next
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
}

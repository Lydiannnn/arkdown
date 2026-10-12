import path from 'node:path'
import { readFile, mkdir, stat } from 'node:fs/promises'
import writeFileAtomic from 'write-file-atomic'
import { MODEL_CAPABILITY_RULES_MAX_BYTES, parseModelCapabilityRules, setModelCapabilityRules, type RuleFile } from '../../shared/model-capability-rules'
import { BUNDLED_MODEL_RULES_REVISION, type ModelCapabilityRulesState } from '../../shared/model-capability-rules-state'

export class ModelCapabilityRulesStore {
  readonly filePath: string
  private rules: RuleFile | null = null
  private warning: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly root: string, private readonly onChanged: (state: ModelCapabilityRulesState) => void = () => undefined) {
    this.filePath = path.join(root, 'model-capabilities.json')
  }
  async load(): Promise<void> {
    this.warning = null
    try {
      if ((await stat(this.filePath)).size > MODEL_CAPABILITY_RULES_MAX_BYTES) throw new Error('Rules too large')
      const value: unknown = JSON.parse((await readFile(this.filePath, 'utf8')).replace(/^\uFEFF/, ''))
      const rules = value === null ? null : parseModelCapabilityRules(value)
      if (rules === undefined) throw new Error('Invalid rules')
      this.rules = rules
    } catch (error) {
      this.rules = null
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warning = '本地模型规则无法读取，已使用内置规则；原文件保留。'
    }
    setModelCapabilityRules(this.rules)
  }
  getState(): ModelCapabilityRulesState {
    return { rules: structuredClone(this.rules), bundledRevision: BUNDLED_MODEL_RULES_REVISION, warning: this.warning }
  }
  update(value: RuleFile | null): Promise<ModelCapabilityRulesState> {
    const parsed = value === null ? null : parseModelCapabilityRules(value)
    if (parsed === undefined) return Promise.reject(new Error('Invalid rules'))
    const save = this.queue.catch(() => undefined).then(async () => {
      await mkdir(this.root, { recursive: true })
      await writeFileAtomic(this.filePath, JSON.stringify(parsed), { encoding: 'utf8', fsync: true })
      this.rules = parsed
      this.warning = null
      setModelCapabilityRules(parsed)
      const state = this.getState()
      this.onChanged(state)
      return state
    })
    this.queue = save
    return save
  }
}

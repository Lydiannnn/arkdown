import type { RegistryBoundary, RegistryKey, RegistryValue } from '../../src/main/shell-integration/windows-registry'
const str = (data: string): RegistryValue => ({ kind: 'String', data })
export class MemoryRegistry implements RegistryBoundary {
  user = new Map<string, RegistryKey>()
  machine = new Map<string, RegistryKey>()
  writes = 0
  failAt = -1
  choices = new Map<string, string>()
  seed(key: string, values: Record<string, string>, user = false) {
    ;(user ? this.user : this.machine).set(key.toLowerCase(), { values: Object.fromEntries(Object.entries(values).map(([name, data]) => [name, str(data)])), subkeys: [] })
  }
  async read(key: string, scope: 'user' | 'effective' = 'effective'): Promise<RegistryKey | null> {
    const lower = key.toLowerCase()
    const base = scope === 'effective' ? this.machine.get(lower) : undefined
    const own = this.user.get(lower)
    const subkeys = [...new Set([...this.user.keys(), ...(scope === 'effective' ? this.machine.keys() : [])].filter((candidate) => candidate.startsWith(`${lower}\\`)).map((candidate) => candidate.slice(lower.length + 1).split('\\')[0]))]
    if (!base && !own && !subkeys.length) return null
    return structuredClone({ values: { ...base?.values, ...own?.values }, subkeys })
  }
  async userChoice(extension: string) { return this.choices.get(extension) ?? null }
  async releaseOwnedDefault(extension: '.md' | '.txt', progId: string, _executable: string) {
    if (this.choices.get(extension) === progId) this.choices.delete(extension)
  }
  async change(key: string, name: string, before: RegistryValue | null, after: RegistryValue | null): Promise<string[]> {
    if (++this.writes === this.failAt) throw new Error('write failed')
    const lower = key.toLowerCase()
    const current = this.user.get(lower)?.values[name] ?? null
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('concurrent edit')
    const created: string[] = []
    if (after) {
      const parts = key.split('\\')
      for (let i = 1; i <= parts.length; i++) {
        const parent = parts.slice(0, i).join('\\')
        if (!await this.read(parent, 'user')) { this.user.set(parent.toLowerCase(), { values: {}, subkeys: [] }); created.push(parent) }
      }
      this.user.get(lower)!.values[name] = structuredClone(after)
    } else if (this.user.has(lower)) delete this.user.get(lower)!.values[name]
    return created
  }
  async removeEmpty(key: string) {
    const snapshot = await this.read(key, 'user')
    if (snapshot && !Object.keys(snapshot.values).length && !snapshot.subkeys.length) this.user.delete(key.toLowerCase())
  }
  async notify() {}
}

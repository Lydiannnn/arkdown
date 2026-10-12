import path from 'node:path'
import { PublicError } from '../../shared/public-errors'
import type { ShellIntegrationFeature } from '../../shared/shell-integration-preferences'
import { registryValue, sameRegistryValue, WindowsShellRegistry, type RegistryBoundary, type RegistryValue } from './windows-registry'

type Feature = ShellIntegrationFeature | 'desktopNote'
export interface ShellRegistrationIntent { explicitEnable?: boolean }
interface OwnedValue { key: string; name: string; value: RegistryValue }
interface MarkdownDescription { progId: string; userChoice: string | null; open: RegistryValue }
interface Ownership { executable: string; values: OwnedValue[]; createdKeys: string[]; markdownDescription?: MarkdownDescription; markdownCandidate?: true }
interface MenuPlan { values: OwnedValue[]; markdownDescription?: MarkdownDescription; markdownCandidate?: true }
interface Change { key: string; name: string; before: RegistryValue | null; after: RegistryValue | null }
const string = (data: string): RegistryValue => ({ kind: 'String', data })
const markdownDescriptionValue = string('Markdown 文档')
const markdownCandidateId = 'Arkdown.Document.Markdown'
const ledgerRoot = 'Arkdown.ShellIntegration'
const desktopKey = 'DesktopBackground\\Shell\\Arknote'
function conflict(): never { throw new PublicError('SHELL_INTEGRATION_CONFLICT') }
function unsupported(): never { throw new PublicError('SHELL_INTEGRATION_UNSUPPORTED') }
function typeId(value: RegistryValue | null): string | null {
  if (!value) return null
  if (value.kind !== 'String' || typeof value.data !== 'string' || !/^[a-z0-9_.-]+$/i.test(value.data)) return unsupported()
  return value.data
}

/** Only the three implemented Arkdown/Arknote menu features use this ownership journal. */
export class ShellMenuRegistration {
  private tail = Promise.resolve()
  private readonly registry: RegistryBoundary
  private readonly executable: string
  private readonly markdownIcon: RegistryValue
  private readonly isCurrentMarkdownDefault: () => Promise<boolean>
  constructor(options: { executablePath: string; iconDirectory?: string; registry?: RegistryBoundary; isCurrentMarkdownDefault?: () => Promise<boolean> }) {
    this.executable = options.executablePath
    this.markdownIcon = string(`"${path.win32.join(options.iconDirectory ?? path.win32.join(path.win32.dirname(this.executable), 'resources', 'branding'), 'ark-md.ico')}",0`)
    this.registry = options.registry ?? new WindowsShellRegistry()
    this.isCurrentMarkdownDefault = options.isCurrentMarkdownDefault ?? (async () => {
      // This query is part of the current registration transaction. A second
      // registry would wait for the lane already held by this operation.
      if (this.registry instanceof WindowsShellRegistry) {
        return (await this.registry.defaultApplicationsStatus(this.executable)).markdown
      }
      const registry = new WindowsShellRegistry()
      try { return (await registry.defaultApplicationsStatus(this.executable)).markdown } finally { await registry.close() }
    })
  }

  setEnabled(feature: Feature, enabled: boolean, persist: () => Promise<void> = async () => {}, intent: ShellRegistrationIntent = {}): Promise<void> {
    const operation = this.tail.then(async () => {
      try { await this.apply(feature, enabled, persist, enabled && intent.explicitEnable === true) }
      finally { await this.registry.close?.() }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private async readOwnership(feature: Feature, explicitEnable = false): Promise<{ ownership: Ownership | null; expected: RegistryValue | null }> {
    const value = registryValue(await this.registry.read(`${ledgerRoot}\\${feature}`, 'user'), 'Ownership')
    if (!value) return { ownership: null, expected: null }
    try {
      if (value.kind !== 'String' || typeof value.data !== 'string') return conflict()
      const parsed = JSON.parse(value.data) as Ownership
      if ((!explicitEnable && parsed.executable !== this.executable) || typeof parsed.executable !== 'string'
        || !path.win32.isAbsolute(parsed.executable) || /["\r\n\0]/.test(parsed.executable)
        || !Array.isArray(parsed.values) || !Array.isArray(parsed.createdKeys)
        || parsed.values.length > 128 || parsed.createdKeys.length > 256) return conflict()
      const description = parsed.markdownDescription
      if (parsed.markdownCandidate !== undefined) {
        if (feature !== 'markdownShellNew' || parsed.markdownCandidate !== true || description !== undefined
          || parsed.values.some((entry) => entry?.key !== '.md\\ShellNew' || entry.name !== 'NullFile'
            || !sameRegistryValue(entry.value, string('')))) return conflict()
        await this.assertMarkdownCandidate()
      }
      if (description !== undefined) {
        if (feature !== 'markdownShellNew' || !description || typeof description.progId !== 'string'
          || !/^[a-z0-9][a-z0-9_.-]{0,254}$/i.test(description.progId)
          || (description.userChoice !== null && typeof description.userChoice !== 'string')
          || !description.open || !['String', 'ExpandString'].includes(description.open.kind)
          || typeof description.open.data !== 'string' || !description.open.data.trim()
          || parsed.values.filter((entry) => entry?.key === description.progId && entry.name === ''
            && sameRegistryValue(entry.value, markdownDescriptionValue)).length !== 1) return conflict()
      }
      const allowed = (key: string) => typeof key === 'string' && key.length < 512 && !key.includes('..')
        && (feature === 'desktopNote' ? key === desktopKey || key === `${desktopKey}\\command`
          : feature === 'documentOpenMenu' ? /^SystemFileAssociations\\\.[a-z0-9]+\\shell\\Arkdown(?:\\command)?$/i.test(key)
            : /^(?:\.md(?:\\[a-z0-9_.-]+)?\\ShellNew|[a-z0-9_.-]+\\ShellNew|\.md|Arkdown\.Markdown(?:\\DefaultIcon|\\shell\\open\\command)?)$/i.test(key))
      const ownedDescription = (entry: OwnedValue) => description !== undefined && entry.key === description.progId
        && entry.name === '' && sameRegistryValue(entry.value, markdownDescriptionValue)
      const allowedEntry = (entry: OwnedValue) => description && entry.key === description.progId
        ? ownedDescription(entry) : allowed(entry.key)
      if (parsed.values.some((entry) => !entry || !allowedEntry(entry) || typeof entry.name !== 'string'
        || entry.value?.kind !== 'String' || typeof entry.value.data !== 'string')) return conflict()
      // Parent cleanup is limited to ancestors of the recorded values and our journal.
      if (parsed.createdKeys.some((key) => typeof key !== 'string' || ![...parsed.values.map((entry) => entry.key), `${ledgerRoot}\\${feature}`]
        .some((leaf) => leaf === key || leaf.startsWith(`${key}\\`)))) return conflict()
      let expected = value
      if (description) {
        const choice = await this.registry.userChoice('.md')
        if (choice !== description.userChoice) {
          if (choice !== 'Arkdown.Document.Markdown' || !await this.isCurrentMarkdownDefault()) return conflict()
          const rebound = { ...description, userChoice: choice }
          await this.assertMarkdownDescription(rebound, markdownDescriptionValue)
          if (!sameRegistryValue(registryValue(await this.registry.read(description.progId, 'user'), ''), markdownDescriptionValue)) return conflict()
          parsed.markdownDescription = rebound
          if (parsed.executable === this.executable) {
            expected = string(JSON.stringify(parsed))
            // Existing current-copy metadata repair remains independent. A takeover
            // instead writes this binding inside its rollback/persistence transaction.
            await this.registry.change(`${ledgerRoot}\\${feature}`, 'Ownership', value, expected)
          }
        }
        await this.assertMarkdownDescription(parsed.markdownDescription!, markdownDescriptionValue)
        if (!sameRegistryValue(registryValue(await this.registry.read(description.progId, 'user'), ''), markdownDescriptionValue)) return conflict()
      }
      return { ownership: parsed, expected }
    } catch { return conflict() }
  }

  private async assertMarkdownDescription(binding: MarkdownDescription, expected: RegistryValue | null) {
    if (!sameRegistryValue(registryValue(await this.registry.read('.md'), ''), string(binding.progId))
      || await this.registry.userChoice('.md') !== binding.userChoice
      || !sameRegistryValue(registryValue(await this.registry.read(`${binding.progId}\\shell\\open\\command`), ''), binding.open)) return conflict()
    const type = await this.registry.read(binding.progId)
    if (registryValue(type, 'FriendlyTypeName') || !sameRegistryValue(registryValue(type, ''), expected)) return conflict()
  }

  private async assertMarkdownCandidate() {
    if (registryValue(await this.registry.read('.md'), '')
      || await this.registry.userChoice('.md') !== markdownCandidateId
      || !await this.isCurrentMarkdownDefault()) return conflict()
    const command = await this.registry.read(`${markdownCandidateId}\\shell\\open\\command`)
    const type = await this.registry.read(markdownCandidateId)
    if (!sameRegistryValue(registryValue(command, ''), string(`"${this.executable}" "%1"`))
      || Object.keys(command!.values).some((name) => name !== '') || command!.subkeys.length
      || !sameRegistryValue(registryValue(type, ''), markdownDescriptionValue)
      || registryValue(type, 'FriendlyTypeName')) return conflict()
  }

  private async assertKnownVerbShape(plan: OwnedValue[]) {
    for (const key of [...new Set(plan.map((entry) => entry.key))]) {
      const entry = await this.registry.read(key)
      if (Object.keys(entry?.values ?? {}).some((name) => !plan.some((item) => item.key === key && item.name.toLowerCase() === name.toLowerCase()))
        || entry?.subkeys.some((subkey) => !plan.some((item) => item.key.toLowerCase() === `${key}\\${subkey}`.toLowerCase()))) return conflict()
    }
  }

  private async menuPlan(feature: Feature): Promise<MenuPlan> {
    if (!path.win32.isAbsolute(this.executable) || /["\r\n\0]/.test(this.executable)) return unsupported()
    if (feature === 'documentOpenMenu') return { values: ['md', 'txt'].flatMap((extension) => {
      const key = `SystemFileAssociations\\.${extension}\\shell\\Arkdown`
      return [{ key, name: '', value: string('使用 Arkdown 打开') }, { key, name: 'Icon', value: string(this.executable) }, { key: `${key}\\command`, name: '', value: string(`"${this.executable}" "%1"`) }]
    }) }
    if (feature === 'desktopNote') return { values: [
      { key: desktopKey, name: '', value: string('创建新便签') },
      { key: desktopKey, name: 'Icon', value: string(this.executable) },
      { key: `${desktopKey}\\command`, name: '', value: string(`"${this.executable}" --new-note`) },
    ] }
    const extension = '.md'
    const root = await this.registry.read(extension)
    let progId = typeId(registryValue(root, ''))
    const choice = await this.registry.userChoice(extension)
    const plan: OwnedValue[] = []
    let markdownDescription: MarkdownDescription | undefined
    let markdownCandidate: true | undefined
    if (!progId && choice === markdownCandidateId) {
      await this.assertMarkdownCandidate()
      progId = markdownCandidateId
      markdownCandidate = true
    }
    if (!progId) {
      if (choice) return unsupported()
      // An opt-in fallback is allowed only when the default value is absent.
      if (await this.registry.read('Arkdown.Markdown')) return conflict()
      plan.push(
        { key: 'Arkdown.Markdown', name: '', value: string('Markdown 文档') },
        { key: 'Arkdown.Markdown\\DefaultIcon', name: '', value: this.markdownIcon },
        { key: 'Arkdown.Markdown\\shell\\open\\command', name: '', value: string(`"${this.executable}" "%1"`) },
        { key: '.md', name: '', value: string('Arkdown.Markdown') },
      )
    } else {
      const open = registryValue(await this.registry.read(`${progId}\\shell\\open\\command`), '')
      if (!open || !['String', 'ExpandString'].includes(open.kind) || typeof open.data !== 'string' || !open.data.trim()) return unsupported()
      const type = await this.registry.read(progId)
      const description = registryValue(type, ''), friendly = registryValue(type, 'FriendlyTypeName')
      if (description && (description.kind !== 'String' || typeof description.data !== 'string' || !description.data.trim())) return unsupported()
      if (friendly && (!['String', 'ExpandString'].includes(friendly.kind) || typeof friendly.data !== 'string'
        || !/^@[^\r\n]+,-?\d+$/.test(friendly.data))) return unsupported()
      if (!description && !friendly) {
        if (!/^[a-z0-9][a-z0-9_.-]{0,254}$/i.test(progId)) return unsupported()
        markdownDescription = { progId, userChoice: choice, open }
        plan.push({ key: progId, name: '', value: markdownDescriptionValue })
      }
    }
    const candidates = [...new Set([`${extension}\\ShellNew`, ...(progId ? [`${extension}\\${progId}\\ShellNew`, `${progId}\\ShellNew`] : []),
      ...(root?.subkeys ?? []).filter((key) => /^[a-z0-9_.-]+$/i.test(key) && key.toLowerCase() !== 'shellnew').map((key) => `${extension}\\${key}\\ShellNew`)])]
    const present: string[] = []
    for (const key of candidates) {
      const entry = await this.registry.read(key)
      if (!entry) continue
      // NullFile alone is proven safe; reject handlers, customized strategies, and ambiguous nested layouts.
      if (entry.subkeys.length || Object.keys(entry.values).some((name) => name.toLowerCase() !== 'nullfile')
        || (registryValue(entry, 'NullFile') && !sameRegistryValue(registryValue(entry, 'NullFile'), string('')))) return conflict()
      present.push(key)
    }
    if (present.length > 1) return unsupported()
    const key = present[0] ?? `${extension}\\ShellNew`
    // This compatibility path owns only the extension's standard empty creation
    // entry, never values or nested creation strategies inside the dedicated type.
    if (markdownCandidate && key !== '.md\\ShellNew') return unsupported()
    plan.push({ key, name: 'NullFile', value: string('') })
    return { values: plan, markdownDescription, markdownCandidate }
  }

  private async apply(feature: Feature, enabled: boolean, persist: () => Promise<void>, explicitEnable: boolean): Promise<void> {
    const journalKey = `${ledgerRoot}\\${feature}`
    const { ownership, expected: journalBefore } = await this.readOwnership(feature, explicitEnable)
    let markdownDescription = ownership?.markdownDescription
    let markdownCandidate = ownership?.markdownCandidate
    let cleanupKeys = ownership?.createdKeys ?? []
    const changes: Change[] = []
    const createdKeys: string[] = []
    const change = async (key: string, name: string, before: RegistryValue | null, after: RegistryValue | null) => {
      // A later read may reject the operation, but must never authorize a new baseline.
      if (!sameRegistryValue(registryValue(await this.registry.read(key, 'user'), name), before)) return conflict()
      if (sameRegistryValue(before, after)) return
      const created = await this.registry.change(key, name, before, after)
      changes.push({ key, name, before, after })
      createdKeys.push(...created)
    }
    const clean = async (keys: string[]) => {
      for (const key of [...new Set(keys)].sort((a, b) => b.split('\\').length - a.split('\\').length)) await this.registry.removeEmpty(key)
    }
    try {
      let replacedExecutable = false
      if (explicitEnable && ownership?.executable === this.executable) {
        const executableValues = ownership.values.filter((entry) => entry.name === '' && (
          entry.key === `${desktopKey}\\command` || entry.key === 'Arkdown.Markdown\\shell\\open\\command'
          || /^SystemFileAssociations\\\.(?:md|txt)\\shell\\Arkdown\\command$/.test(entry.key)))
        for (const entry of executableValues) {
          const value = registryValue(await this.registry.read(entry.key, 'user'), entry.name)
          if (value && !sameRegistryValue(value, entry.value)) replacedExecutable = true
        }
      }
      if (explicitEnable && (!ownership || ownership.executable !== this.executable || replacedExecutable)) {
        const menu = await this.menuPlan(feature)
        markdownDescription = ownership?.markdownDescription ?? menu.markdownDescription
        markdownCandidate = ownership?.markdownCandidate ?? menu.markdownCandidate
        const plan = [...menu.values]
        const historicalFallback: OwnedValue[] = []
        if (feature === 'markdownShellNew'
          && sameRegistryValue(registryValue(await this.registry.read('.md', 'user'), ''), string('Arkdown.Markdown'))) {
          const commandKey = 'Arkdown.Markdown\\shell\\open\\command'
          const command = registryValue(await this.registry.read(commandKey, 'user'), '')
          const match = command?.kind === 'String' && typeof command.data === 'string' ? /^"([^"\r\n\0]+)" "%1"$/.exec(command.data) : null
          if (match && path.win32.isAbsolute(match[1]) && /^Arkdown\.exe$/i.test(path.win32.basename(match[1]))
            && sameRegistryValue(registryValue(await this.registry.read('Arkdown.Markdown', 'user'), ''), markdownDescriptionValue)
            && !registryValue(await this.registry.read('Arkdown.Markdown'), 'FriendlyTypeName')) {
            // Recognize only the complete legacy fallback, never an arbitrary
            // configured type. A preexisting NullFile still remains unowned.
            historicalFallback.push({ key: '.md', name: '', value: string('Arkdown.Markdown') },
              { key: 'Arkdown.Markdown', name: '', value: markdownDescriptionValue },
              { key: commandKey, name: '', value: command! })
            const previousIcon = registryValue(await this.registry.read('Arkdown.Markdown\\DefaultIcon', 'user'), '')
            if (previousIcon) {
              const expectedIcon = string(`"${path.win32.join(path.win32.dirname(match[1]), 'resources', 'branding', 'ark-md.ico')}",0`)
              const journalIcon = ownership?.values.find((entry) => entry.key === 'Arkdown.Markdown\\DefaultIcon' && entry.name === '')
              if (!sameRegistryValue(previousIcon, expectedIcon)
                && !(ownership?.executable === this.executable && journalIcon && sameRegistryValue(previousIcon, journalIcon.value))) return conflict()
              historicalFallback.push({ key: 'Arkdown.Markdown\\DefaultIcon', name: '', value: previousIcon })
            }
            await this.assertKnownVerbShape(historicalFallback.filter((entry) => entry.key !== '.md').concat([
              { key: 'Arkdown.Markdown\\shell', name: '', value: string('') },
              { key: 'Arkdown.Markdown\\shell\\open', name: '', value: string('') },
            ]))
            if (!ownership) plan.push(...historicalFallback.map((entry) => ({ ...entry, value: entry.key === commandKey
              ? string(`"${this.executable}" "%1"`) : entry.key === 'Arkdown.Markdown\\DefaultIcon' ? this.markdownIcon : entry.value })))
          }
        }
        if (ownership && feature === 'markdownShellNew') {
          // Only the known fallback can change executable. Foreign defaults and
          // description bindings remain exactly as observed by the old owner.
          for (const entry of ownership.values) {
            const fallback = entry.key === 'Arkdown.Markdown' && entry.name === '' && sameRegistryValue(entry.value, markdownDescriptionValue)
              || entry.key === 'Arkdown.Markdown\\DefaultIcon' && entry.name === ''
                && sameRegistryValue(entry.value, string(`"${path.win32.join(path.win32.dirname(ownership.executable), 'resources', 'branding', 'ark-md.ico')}",0`))
              || entry.key === '.md' && entry.name === '' && sameRegistryValue(entry.value, string('Arkdown.Markdown'))
              || entry.key === 'Arkdown.Markdown\\shell\\open\\command' && entry.name === ''
                && sameRegistryValue(entry.value, string(`"${ownership.executable}" "%1"`))
            const described = markdownDescription && entry.key === markdownDescription.progId && entry.name === ''
              && sameRegistryValue(entry.value, markdownDescriptionValue)
            if (!fallback && !described && !plan.some((item) => item.key === entry.key && item.name === entry.name
              && sameRegistryValue(item.value, entry.value))) return conflict()
            const baseline = historicalFallback.find((item) => item.key === entry.key && item.name === entry.name)?.value ?? entry.value
            if (!sameRegistryValue(registryValue(await this.registry.read(entry.key, 'user'), entry.name), baseline)) return conflict()
            if (!plan.some((item) => item.key === entry.key && item.name === entry.name)) {
              plan.push({ ...entry, value: entry.key === 'Arkdown.Markdown\\shell\\open\\command'
                ? string(`"${this.executable}" "%1"`) : entry.key === 'Arkdown.Markdown\\DefaultIcon' ? this.markdownIcon : entry.value })
            }
          }
        }
        if (feature === 'markdownShellNew' && plan.some((entry) => entry.key === 'Arkdown.Markdown\\shell\\open\\command')
          && !plan.some((entry) => entry.key === 'Arkdown.Markdown\\DefaultIcon')) {
          plan.push({ key: 'Arkdown.Markdown\\DefaultIcon', name: '', value: this.markdownIcon })
        }
        if (ownership && feature !== 'markdownShellNew' && ownership.values.some((entry) =>
          (feature === 'desktopNote' || plan.some((item) => item.key === entry.key))
          && !plan.some((item) => item.key === entry.key && item.name === entry.name))) return conflict()
        const snapshots: Change[] = []
        const owned: OwnedValue[] = []
        const observed = new Map<string, RegistryValue | null>()
        const fallbackCommand = plan.filter((entry) => entry.key === 'Arkdown.Markdown\\shell\\open\\command')
        if (fallbackCommand.length) await this.assertKnownVerbShape(fallbackCommand)
        if (feature !== 'markdownShellNew') {
          // A historical verb must be complete and point consistently at an
          // Arkdown/Arknote executable; handlers and extra strategies still fail.
          for (const key of [...new Set(plan.filter((entry) => entry.name === 'Icon').map((entry) => entry.key))]) {
            const verb = await this.registry.read(key)
            const command = await this.registry.read(`${key}\\command`)
            observed.set(`${key}|`, registryValue(verb, ''))
            observed.set(`${key}|Icon`, registryValue(verb, 'Icon'))
            observed.set(`${key}\\command|`, registryValue(command, ''))
            if (!verb && !command) continue
            const icon = registryValue(verb, 'Icon')
            if (icon?.kind !== 'String' || typeof icon.data !== 'string' || !path.win32.isAbsolute(icon.data)
              || /["\r\n\0]/.test(icon.data) || !/^(?:Arkdown|Arknote)\.exe$/i.test(path.win32.basename(icon.data))
              || !sameRegistryValue(registryValue(verb, ''), plan.find((entry) => entry.key === key && entry.name === '')!.value)
              || !sameRegistryValue(registryValue(command, ''), string(`"${icon.data}" ${feature === 'desktopNote' ? '--new-note' : '"%1"'}`))) return conflict()
          }
          await this.assertKnownVerbShape(plan)
        }
        for (const entry of plan) {
          const effective = registryValue(await this.registry.read(entry.key), entry.name)
          const before = registryValue(await this.registry.read(entry.key, 'user'), entry.name)
          const previouslyOwned = [...historicalFallback, ...ownership?.values ?? []].find((item) => item.key === entry.key && item.name === entry.name)
          if (before && !sameRegistryValue(before, effective)) return conflict()
          if (feature !== 'markdownShellNew' && !sameRegistryValue(effective, observed.get(`${entry.key}|${entry.name}`) ?? null)) return conflict()
          if (feature === 'markdownShellNew' && previouslyOwned && !sameRegistryValue(before, previouslyOwned.value)) return conflict()
          if (feature === 'markdownShellNew' && effective && !previouslyOwned) {
            if (entry.name === 'NullFile' && sameRegistryValue(effective, entry.value)) continue
            return conflict()
          }
          snapshots.push({ key: entry.key, name: entry.name, before, after: entry.value })
          owned.push(entry)
        }
        for (const entry of snapshots) {
          if (menu.markdownDescription && entry.key === menu.markdownDescription.progId) await this.assertMarkdownDescription(menu.markdownDescription, null)
          await change(entry.key, entry.name, entry.before, entry.after)
        }
        const leaves = [...owned.map((entry) => entry.key), journalKey]
        const inheritedKeys = (ownership?.createdKeys ?? []).filter((key) => leaves.some((leaf) => leaf === key || leaf.startsWith(`${key}\\`)))
        cleanupKeys = inheritedKeys
        for (const key of [ledgerRoot, journalKey]) if (!await this.registry.read(key, 'user')) createdKeys.push(key)
        await change(journalKey, 'Ownership', journalBefore, string(JSON.stringify({ executable: this.executable, values: owned,
          createdKeys: [...new Set([...inheritedKeys, ...createdKeys])], markdownDescription, markdownCandidate } satisfies Ownership)))
        // Recheck effective activation before committing the checkbox transaction.
        await this.menuPlan(feature)
        if (feature !== 'markdownShellNew') await this.assertKnownVerbShape(plan)
        if (fallbackCommand.length) await this.assertKnownVerbShape(fallbackCommand)
        for (const entry of plan) if (!sameRegistryValue(registryValue(await this.registry.read(entry.key), entry.name), entry.value)) return conflict()
      } else if (ownership) {
        const required = enabled && feature === 'documentOpenMenu' ? (await this.menuPlan(feature)).values : null
        // Validate the entire old verb before removing any obsolete extension.
        if (feature === 'documentOpenMenu') {
          for (const key of [...new Set(ownership.values.map((entry) => entry.key))]) {
            const current = await this.registry.read(key)
            if (Object.keys(current?.values ?? {}).some((name) => !ownership.values.some((entry) => entry.key === key && entry.name.toLowerCase() === name.toLowerCase()))
              || current?.subkeys.some((subkey) => !ownership.values.some((entry) => entry.key.toLowerCase() === `${key}\\${subkey}`.toLowerCase()))) return conflict()
          }
        }
        const ownedChanges: Change[] = []
        for (const entry of ownership.values) {
          const current = registryValue(await this.registry.read(entry.key, 'user'), entry.name)
          if (current && !sameRegistryValue(current, entry.value)) return conflict()
          // Never restore an absent user value over a new machine-level registration.
          if (!current && enabled && registryValue(await this.registry.read(entry.key), entry.name)) return conflict()
          const keep = enabled && (!required || required.some((candidate) => candidate.key === entry.key && candidate.name === entry.name))
          ownedChanges.push({ key: entry.key, name: entry.name, before: current, after: keep ? entry.value : null })
        }
        for (const entry of ownedChanges) await change(entry.key, entry.name, entry.before, entry.after)
        // Upgrade the exact journal-owned ShellNew fallback; external defaults stay untouched.
        if (enabled && feature === 'markdownShellNew'
          && ownership.values.some((entry) => entry.key === 'Arkdown.Markdown\\shell\\open\\command'
            && sameRegistryValue(entry.value, string(`"${this.executable}" "%1"`)))
          && !ownership.values.some((entry) => entry.key === 'Arkdown.Markdown\\DefaultIcon')) {
          const key = 'Arkdown.Markdown\\DefaultIcon'
          if (await this.registry.read(key)) return conflict()
          await change(key, '', null, this.markdownIcon)
          ownership.values.push({ key, name: '', value: this.markdownIcon })
          ownership.createdKeys.push(...createdKeys)
          await change(journalKey, 'Ownership', journalBefore, string(JSON.stringify(ownership)))
        }
        if (enabled) {
          const { values: required } = await this.menuPlan(feature)
          for (const entry of required) {
            if (!sameRegistryValue(registryValue(await this.registry.read(entry.key), entry.name), entry.value)) return conflict()
          }
          if (feature !== 'markdownShellNew') {
            for (const key of [...new Set(required.map((entry) => entry.key))]) {
              const current = await this.registry.read(key)
              if (Object.keys(current?.values ?? {}).some((name) => !required.some((entry) => entry.key === key && entry.name.toLowerCase() === name.toLowerCase()))
                || current?.subkeys.some((subkey) => !required.some((entry) => entry.key.toLowerCase() === `${key}\\${subkey}`.toLowerCase()))) return conflict()
            }
          }
        }
        // Obsolete verbs must still be empty after deletion; an external handler
        // added during migration aborts the journal update and restores our values.
        if (feature === 'documentOpenMenu') {
          for (const key of [...new Set(ownedChanges.filter((entry) => entry.after === null).map((entry) => entry.key))]) {
            const current = await this.registry.read(key)
            if (Object.keys(current?.values ?? {}).length
              || current?.subkeys.some((subkey) => !ownedChanges.some((entry) => entry.after === null
                && entry.key.toLowerCase() === `${key}\\${subkey}`.toLowerCase()))) return conflict()
          }
        }
        if (!enabled) await change(journalKey, 'Ownership', journalBefore, null)
        else if (required && ownership.values.some((entry) => !required.some((candidate) => candidate.key === entry.key && candidate.name === entry.name))) {
          const values = ownership.values.filter((entry) => required.some((candidate) => candidate.key === entry.key && candidate.name === entry.name))
          await change(journalKey, 'Ownership', journalBefore, string(JSON.stringify({ ...ownership, values,
            createdKeys: ownership.createdKeys.filter((key) => [...values.map((entry) => entry.key), journalKey].some((leaf) => leaf === key || leaf.startsWith(`${key}\\`))),
          })))
        }
      } else if (enabled) {
        const menu = await this.menuPlan(feature)
        const plan = menu.values
        markdownDescription = menu.markdownDescription
        markdownCandidate = menu.markdownCandidate
        const owned: OwnedValue[] = []
        // Recognize the complete historical Arknote registration, never a partial lookalike.
        const legacy = feature === 'desktopNote' && (await Promise.all(plan.map(async (entry) =>
          sameRegistryValue(registryValue(await this.registry.read(entry.key, 'user'), entry.name), entry.value)))).every(Boolean)
        for (const entry of plan) {
          const current = registryValue(await this.registry.read(entry.key), entry.name)
          if (current) {
            if (legacy) owned.push(entry)
            else if (feature === 'markdownShellNew' && entry.name === 'NullFile' && sameRegistryValue(current, entry.value)) { /* preexisting empty creation remains unowned */ }
            else return conflict()
          } else owned.push(entry)
        }
        // A foreign verb with additional values/subkeys is never adopted or partially overwritten.
        if (feature === 'desktopNote' || feature === 'documentOpenMenu') {
          for (const key of [...new Set(plan.map((entry) => entry.key))]) {
            const existing = await this.registry.read(key)
            if (!existing) continue
            if (!legacy || Object.keys(existing.values).some((name) => !plan.some((entry) => entry.key === key && entry.name.toLowerCase() === name.toLowerCase()))
              || existing.subkeys.some((subkey) => !plan.some((entry) => entry.key.toLowerCase() === `${key}\\${subkey}`.toLowerCase()))) return conflict()
          }
        }
        for (const entry of owned) {
          if (markdownDescription && entry.key === markdownDescription.progId) await this.assertMarkdownDescription(markdownDescription, null)
          await change(entry.key, entry.name, legacy ? entry.value : null, entry.value)
        }
        // These two exact legacy keys were created by the previous Arknote implementation.
        if (legacy) createdKeys.push(desktopKey, `${desktopKey}\\command`)
        const ledgerParents = [ledgerRoot, journalKey]
        for (const key of ledgerParents) if (!await this.registry.read(key, 'user')) createdKeys.push(key)
        await change(journalKey, 'Ownership', journalBefore, string(JSON.stringify({ executable: this.executable, values: owned, createdKeys, markdownDescription, markdownCandidate } satisfies Ownership)))
      }
      if (markdownDescription) await this.assertMarkdownDescription(markdownDescription, enabled ? markdownDescriptionValue : null)
      if (markdownCandidate) await this.assertMarkdownCandidate()
      await persist()
    } catch (error) {
      let rollbackFailed = false
      for (const entry of changes.reverse()) {
        try {
          // Never restore our deleted description over a newly exposed machine-level value.
          if (markdownDescription && entry.key === markdownDescription.progId && entry.before && !entry.after
            && registryValue(await this.registry.read(entry.key), entry.name)) return conflict()
          await this.registry.change(entry.key, entry.name, entry.after, entry.before)
        } catch { rollbackFailed = true }
      }
      try { await clean(createdKeys) } catch { rollbackFailed = true }
      if (changes.length) await this.registry.notify().catch(() => undefined)
      if (rollbackFailed) throw new PublicError('SHELL_INTEGRATION_ROLLBACK_INCOMPLETE')
      throw error
    }
    // Cleanup is cosmetic and cannot invalidate an already persisted checkbox.
    if (ownership) await clean(cleanupKeys).catch(() => undefined)
    if (changes.length) await this.registry.notify().catch(() => undefined)
  }
}

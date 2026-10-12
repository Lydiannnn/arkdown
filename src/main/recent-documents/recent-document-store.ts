import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import {
  isRecentDocumentsFile,
  isSupportedRecentDocumentPath,
  RECENT_DOCUMENT_CANDIDATE_LIMIT,
  RECENT_DOCUMENT_FILE_MAX_BYTES,
  RECENT_DOCUMENT_LIMIT,
  type RecentDocumentsFile,
} from '../../shared/recent-documents'
import { recentDocumentsPath } from '../settings/portable-paths'

export interface RecentDocumentStoreDependencies {
  readTextFile(filePath: string): Promise<string>
  isRegularFile(absolutePath: string): Promise<boolean>
  ensureDirectory(directory: string): Promise<void>
  writeTextFileAtomic(filePath: string, contents: string): Promise<void>
}

export interface RecentDocumentStartupLoadOptions {
  maxCandidates?: number
  maxConcurrency?: number
  overallTimeoutMs?: number
  perPathTimeoutMs?: number
}

type StartupValidation = 'missing' | 'unknown' | 'valid'

interface PendingStartupValidation {
  cancel(): void
  promise: Promise<StartupValidation>
}

async function readBoundedTextFile(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const bytes = Buffer.alloc(RECENT_DOCUMENT_FILE_MAX_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > RECENT_DOCUMENT_FILE_MAX_BYTES) {
      throw new Error('Recent document storage exceeds the safe size limit')
    }
    return bytes.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

function defaultDependencies(): RecentDocumentStoreDependencies {
  return {
    readTextFile: readBoundedTextFile,
    isRegularFile: async (absolutePath) => (await stat(absolutePath)).isFile(),
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true })
    },
    writeTextFileAtomic: (filePath, contents) =>
      writeFileAtomic(filePath, contents, { encoding: 'utf8', fsync: true }),
  }
}

function normalizedWindowsPath(absolutePath: string): string {
  return path.win32.normalize(absolutePath)
}

function windowsPathKey(absolutePath: string): string {
  return normalizedWindowsPath(absolutePath).toLocaleLowerCase('en-US')
}

export class RecentDocumentStore {
  readonly filePath: string
  private readonly dependencies: RecentDocumentStoreDependencies
  private paths: string[] = []
  private loaded = false
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    dependencies: Partial<RecentDocumentStoreDependencies> = {},
  ) {
    this.filePath = recentDocumentsPath(root)
    this.dependencies = { ...defaultDependencies(), ...dependencies }
  }

  list(): readonly string[] {
    return [...this.paths]
  }

  load(): Promise<readonly string[]> {
    return this.enqueue(async () => {
      await this.loadIfNeeded('complete')
      return this.list()
    })
  }

  loadForStartup(options: RecentDocumentStartupLoadOptions = {}): Promise<readonly string[]> {
    return this.enqueue(async () => {
      await this.loadIfNeeded('startup', options)
      return this.list()
    })
  }

  record(absolutePath: string): Promise<readonly string[]> {
    return this.enqueue(async () => {
      await this.loadIfNeeded('complete')
      const normalized = await this.validatePath(absolutePath)
      if (!normalized) return this.list()

      const key = windowsPathKey(normalized)
      const previous = this.paths
      this.paths = [
        normalized,
        ...this.paths.filter((candidate) => windowsPathKey(candidate) !== key),
      ].slice(0, RECENT_DOCUMENT_LIMIT)
      try {
        await this.persist()
      } catch (error) {
        this.paths = previous
        throw error
      }
      return this.list()
    })
  }

  remove(absolutePath: string): Promise<readonly string[]> {
    return this.enqueue(async () => {
      await this.loadIfNeeded('complete')
      if (!isSupportedRecentDocumentPath(absolutePath)) return this.list()
      const key = windowsPathKey(absolutePath)
      const remaining = this.paths.filter((candidate) => windowsPathKey(candidate) !== key)
      if (remaining.length === this.paths.length) return this.list()
      const previous = this.paths
      this.paths = remaining
      try {
        await this.persist()
      } catch (error) {
        this.paths = previous
        throw error
      }
      return this.list()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async loadIfNeeded(
    mode: 'complete' | 'startup',
    startupOptions: RecentDocumentStartupLoadOptions = {},
  ): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.dependencies.readTextFile(this.filePath)) as unknown
    } catch {
      this.paths = []
      return
    }
    if (!isRecentDocumentsFile(parsed)) {
      this.paths = []
      return
    }

    const candidateLimit = mode === 'startup'
      ? Math.min(
          RECENT_DOCUMENT_LIMIT,
          Math.max(0, Math.floor(startupOptions.maxCandidates ?? RECENT_DOCUMENT_LIMIT)),
        )
      : RECENT_DOCUMENT_CANDIDATE_LIMIT
    const candidates: string[] = []
    const seen = new Set<string>()
    for (const candidate of parsed.paths.slice(0, candidateLimit)) {
      if (!isSupportedRecentDocumentPath(candidate)) continue
      const normalized = normalizedWindowsPath(candidate)
      const key = windowsPathKey(normalized)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(normalized)
      if (mode === 'startup' && candidates.length === RECENT_DOCUMENT_LIMIT) break
    }
    if (mode === 'startup') {
      this.paths = await this.validateStartupCandidates(candidates, startupOptions)
      return
    }
    const validated: string[] = []
    for (const candidate of candidates) {
      const valid = await this.validatePath(candidate)
      if (valid) validated.push(valid)
      if (validated.length === RECENT_DOCUMENT_LIMIT) break
    }
    this.paths = validated
  }

  private validateStartupCandidates(
    candidates: readonly string[],
    options: RecentDocumentStartupLoadOptions,
  ): Promise<string[]> {
    if (candidates.length === 0) return Promise.resolve([])
    const maxConcurrency = Math.max(
      1,
      Math.min(candidates.length, Math.floor(options.maxConcurrency ?? 4)),
    )
    const overallTimeoutMs = Math.max(0, options.overallTimeoutMs ?? 350)
    const perPathTimeoutMs = Math.max(0, options.perPathTimeoutMs ?? 150)
    const available = [...candidates]

    return new Promise((resolve) => {
      let active = 0
      let next = 0
      let settled = false
      const pending = new Set<PendingStartupValidation>()
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(overallTimer)
        for (const validation of pending) validation.cancel()
        pending.clear()
        resolve(available.filter((candidate): candidate is string => candidate !== ''))
      }
      const launch = () => {
        if (settled) return
        while (active < maxConcurrency && next < candidates.length) {
          const index = next
          next += 1
          active += 1
          const validation = this.startTimedStartupValidation(
            candidates[index],
            perPathTimeoutMs,
          )
          pending.add(validation)
          void validation.promise.then((result) => {
            pending.delete(validation)
            if (settled) return
            active -= 1
            if (result === 'missing') available[index] = ''
            if (next === candidates.length && active === 0) finish()
            else launch()
          })
        }
      }
      const overallTimer = setTimeout(finish, overallTimeoutMs)
      launch()
    })
  }

  private startTimedStartupValidation(
    absolutePath: string,
    timeoutMs: number,
  ): PendingStartupValidation {
    let complete!: (result: StartupValidation) => void
    let settled = false
    const promise = new Promise<StartupValidation>((resolve) => { complete = resolve })
    const finish = (result: StartupValidation) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      complete(result)
    }
    const timer = setTimeout(() => finish('unknown'), timeoutMs)
    void this.dependencies.isRegularFile(absolutePath).then(
      (isFile) => finish(isFile ? 'valid' : 'missing'),
      () => finish('missing'),
    )
    return { cancel: () => finish('unknown'), promise }
  }

  private async validatePath(value: unknown): Promise<string | null> {
    if (!isSupportedRecentDocumentPath(value)) return null
    const normalized = normalizedWindowsPath(value)
    try {
      return await this.dependencies.isRegularFile(normalized) ? normalized : null
    } catch {
      return null
    }
  }

  private async persist(): Promise<void> {
    const file: RecentDocumentsFile = { version: 1, paths: [...this.paths] }
    await this.dependencies.ensureDirectory(this.root)
    await this.dependencies.writeTextFileAtomic(
      this.filePath,
      `${JSON.stringify(file, null, 2)}\n`,
    )
  }
}

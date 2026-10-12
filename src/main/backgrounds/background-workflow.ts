import {
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundTarget,
  type BackgroundApplyResult,
  type ObservedMainBackgroundSnapshot,
} from '../../shared/background-settings'

export type BackgroundImageUpdate =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'replace'; sourceAbsolutePath: string }

export interface BackgroundPresentationEvent {
  target: BackgroundTarget
  presentation: BackgroundPresentation
  phase: 'preview' | 'applied' | 'restore'
}

interface BackgroundWorkflowBackend {
  open?(target: BackgroundTarget): Promise<BackgroundPresentation & { observed?: ObservedMainBackgroundSnapshot }>
  get(target: BackgroundTarget): Promise<BackgroundPresentation>
  previewSource(target: BackgroundTarget, sourceAbsolutePath: string): Promise<string>
  apply(
    target: BackgroundTarget,
    settings: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent?: () => void,
    observed?: ObservedMainBackgroundSnapshot,
  ): Promise<BackgroundApplyResult & { observed?: ObservedMainBackgroundSnapshot }>
}

interface BackgroundWorkflowOptions {
  backend: BackgroundWorkflowBackend
  chooseSource(target: BackgroundTarget): Promise<string | null>
  broadcast(event: BackgroundPresentationEvent): void
}

interface BackgroundSession {
  token?: object
  loading: boolean
  closing: boolean
  applying?: Promise<BackgroundApplyResult>
  observed?: ObservedMainBackgroundSnapshot
  presentation: BackgroundPresentation
  imageUpdate: BackgroundImageUpdate
  deliver(event: BackgroundPresentationEvent): void
}

function keyFor(target: BackgroundTarget): string {
  return target.kind === 'main' ? 'main' : `sticky-note:${target.noteId}`
}

function copyTarget(target: BackgroundTarget): BackgroundTarget {
  return target.kind === 'main'
    ? { kind: 'main' }
    : { kind: 'sticky-note', noteId: target.noteId }
}

function copyPresentation(value: BackgroundPresentation): BackgroundPresentation {
  return {
    settings: copyBackgroundSettings(value.settings),
    imageUrl: value.imageUrl,
  }
}

export class BackgroundWorkflow {
  private readonly sessions = new Map<string, BackgroundSession>()

  constructor(private readonly options: BackgroundWorkflowOptions) {}

  private requireSession(target: BackgroundTarget): BackgroundSession {
    const session = this.sessions.get(keyFor(target))
    if (!session || session.loading || session.closing) throw new Error('Background settings session is unavailable')
    return session
  }

  private assertCurrent(target: BackgroundTarget, session: BackgroundSession): void {
    if (this.sessions.get(keyFor(target)) !== session || session.closing) {
      throw new Error('Background settings session is unavailable')
    }
  }

  private event(
    target: BackgroundTarget,
    presentation: BackgroundPresentation,
    phase: BackgroundPresentationEvent['phase'],
  ): BackgroundPresentationEvent {
    return {
      target: copyTarget(target),
      presentation: copyPresentation(presentation),
      phase,
    }
  }

  async begin(
    target: BackgroundTarget,
    deliver: (event: BackgroundPresentationEvent) => void,
    token?: object,
  ): Promise<BackgroundPresentation> {
    const session: BackgroundSession = {
      token, loading: true, closing: false,
      presentation: { settings: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS), imageUrl: null },
      imageUpdate: { kind: 'keep' },
      deliver,
    }
    this.sessions.set(keyFor(target), session)
    const opened: BackgroundPresentation & { observed?: ObservedMainBackgroundSnapshot } =
      await (this.options.backend.open?.(target) ?? this.options.backend.get(target))
    const presentation = copyPresentation(opened)
    this.assertCurrent(target, session)
    session.presentation = presentation
    if ('observed' in opened && opened.observed) session.observed = structuredClone(opened.observed)
    session.loading = false
    return copyPresentation(presentation)
  }

  get(target: BackgroundTarget): Promise<BackgroundPresentation> {
    return this.options.backend.get(target).then(copyPresentation)
  }

  async getSession(target: BackgroundTarget): Promise<BackgroundPresentation> {
    return copyPresentation(this.requireSession(target).presentation)
  }

  async choose(target: BackgroundTarget): Promise<BackgroundPresentation | null> {
    const session = this.requireSession(target)
    const sourceAbsolutePath = await this.options.chooseSource(target)
    this.assertCurrent(target, session)
    if (sourceAbsolutePath === null) return null
    const imageUrl = await this.options.backend.previewSource(target, sourceAbsolutePath)
    this.assertCurrent(target, session)
    session.imageUpdate = { kind: 'replace', sourceAbsolutePath }
    session.presentation = {
      settings: copyBackgroundSettings(session.presentation.settings),
      imageUrl,
    }
    const result = copyPresentation(session.presentation)
    session.deliver(this.event(target, result, 'preview'))
    return result
  }

  async remove(target: BackgroundTarget): Promise<BackgroundPresentation> {
    const session = this.requireSession(target)
    session.imageUpdate = { kind: 'remove' }
    session.presentation = {
      settings: {
        ...copyBackgroundSettings(session.presentation.settings),
        imageRelativePath: null,
      },
      imageUrl: null,
    }
    const result = copyPresentation(session.presentation)
    session.deliver(this.event(target, result, 'preview'))
    return result
  }

  async preview(target: BackgroundTarget, requested: BackgroundSettings): Promise<void> {
    const session = this.requireSession(target)
    session.presentation = {
      settings: {
        ...copyBackgroundSettings(requested),
        imageRelativePath: session.presentation.settings.imageRelativePath,
      },
      imageUrl: session.presentation.imageUrl,
    }
    session.deliver(this.event(target, session.presentation, 'preview'))
  }

  async apply(
    target: BackgroundTarget,
    requested: BackgroundSettings,
  ): Promise<BackgroundApplyResult> {
    const session = this.requireSession(target)
    const settings = {
      ...copyBackgroundSettings(requested),
      imageRelativePath: session.presentation.settings.imageRelativePath,
    }
    const applying = this.options.backend.apply(
      target,
      settings,
      session.imageUpdate,
      () => this.assertCurrent(target, session),
      ...(session.observed ? [structuredClone(session.observed)] : []),
    )
    session.applying = applying
    const result = await applying
    this.assertCurrent(target, session)
    if ('status' in result) return result
    const applied = copyPresentation(result)
    if (result.observed) session.observed = structuredClone(result.observed)
    session.presentation = applied
    session.imageUpdate = { kind: 'keep' }
    this.options.broadcast(this.event(target, applied, 'applied'))
    return copyPresentation(applied)
  }

  async cancel(target: BackgroundTarget, token?: object): Promise<void> {
    const session = this.sessions.get(keyFor(target))
    if (!session || (token !== undefined && session.token !== token)) return
    session.closing = true
    if (session.applying) await session.applying.catch(() => undefined)
    const restored = copyPresentation(await this.options.backend.get(target))
    if (this.sessions.get(keyFor(target)) !== session) return
    session.deliver(this.event(target, restored, 'restore'))
    this.sessions.delete(keyFor(target))
  }

  end(target: BackgroundTarget, token?: object): void {
    if (token === undefined || this.sessions.get(keyFor(target))?.token === token) {
      this.sessions.delete(keyFor(target))
    }
  }
}

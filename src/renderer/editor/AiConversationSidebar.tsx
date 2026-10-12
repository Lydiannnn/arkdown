import { AiThinkingTime } from './AiThinkingTime'
import { AiRequestTime } from './AiRequestTime'
import { AiProcessPanel } from './AiProcessPanel'
import { AiBudgetNotice } from './AiBudgetNotice'
import type { AiThinkingTime as AiThinkingRecord } from './ai-thinking-time'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AI_CONVERSATION_MESSAGE_MAX_CHARS,
  type AiConversationCapabilities,
  type AiConversationVisibleMessage,
} from '../../shared/ai-conversation'
import type { AiWritePolicy } from '../../shared/large-model-settings'
import { PreferencesSelect } from '../settings/PreferencesSelect'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import {
  aiMessageLinkHref,
  classifyAiMessageLink,
  linkifyAiMessageLocalPaths,
  type AiMessageLinkTarget,
} from './ai-message-links'
import type { AiConversationStatus } from './use-ai-conversation'
import type {
  WorkspaceAiAuthorizationRecord,
  WorkspaceAiAuditRecord,
  WorkspaceAiTimelineEntry,
  WorkspaceAiViewport,
} from './workspace-ai-session-store'
import { ModelConfigurationNotice } from './ModelConfigurationNotice'
import { AppIcon } from '../icons/AppIcon'
import { AiQuoteChip } from './AiQuoteChip'
import { acceptAiComposerSubmission, composeAiMessage, createAiComposerDraft,
  editAiComposerDraft, removeAiSelectionQuote, subscribeAiComposerDraft, type AiComposerDraft } from './ai-composer-draft'
import { ModelThinkingControls, type ThinkingControlProps } from './ModelThinkingControls'
import './ai-conversation-sidebar.css'
import './safe-readonly-markdown.css'

export interface AiConversationSidebarProps extends ThinkingControlProps {
  draft?: AiComposerDraft
  viewport?: WorkspaceAiViewport
  modelConnections?: readonly { id: string; name: string }[]
  selectedModelId?: string | null
  modelSwitchPending?: boolean
  onModelChange?(connectionId: string): void
  configurationState: 'checking' | 'configured' | 'unconfigured' | 'error'
  capabilities: AiConversationCapabilities
  writePolicy: AiWritePolicy
  pendingAuthorization: WorkspaceAiAuthorizationRecord | null
  authorizationRecords: readonly WorkspaceAiAuthorizationRecord[]
  auditRecords: readonly WorkspaceAiAuditRecord[]
  error: string | null
  messages: readonly AiConversationVisibleMessage[]
  activeAssistantMessageId: string | null
  timeline?: readonly WorkspaceAiTimelineEntry[]
  status: AiConversationStatus
  continueRequestId?: string | null
  onContinueAnalysis?(requestId: string): Promise<boolean>
  contextUsage?: {
    usedTokens: number
    contextWindowTokens: number | null
    estimated?: boolean
  } | null
  onClose(): void
  onClear(): void
  onOpenSettings(): void
  onRetryConfiguration(): void
  onRetrySettings?(): void
  onSend(content: string, expectedDocumentId?: string | null): Promise<boolean>
  onStop(): void
  onCurrentDocumentAccessChange(enabled: boolean): void
  onWorkspaceAccessChange(enabled: boolean): void
  onWritePolicyChange(policy: AiWritePolicy): void
  onAuthorizationDecision(allowed: boolean): void
  onOpenLink?(target: AiMessageLinkTarget): void
}

const WRITE_POLICY_OPTIONS: readonly {
  value: AiWritePolicy
  label: string
  description: string
}[] = [
  {
    value: 'ask-every-time',
    label: '每次询问',
    description: '编辑、创建、重命名或删除工作区文档时，每次都申请本次操作许可',
  },
  {
    value: 'document-grant',
    label: '按文档许可',
    description: '直接编辑当前文档；其他文档在当前会话首次写入时申请许可',
  },
  {
    value: 'workspace-grant',
    label: '按工作区许可',
    description: '选择即允许直接编辑、创建、重命名或删除当前工作区文档，仍须开启工作区访问',
  },
]

const AUTHORIZATION_OPERATION_LABEL: Record<WorkspaceAiAuthorizationRecord['toolName'], string> = {
  edit_workspace_document: '编辑',
  create_workspace_document: '创建',
  rename_workspace_document: '重命名',
  delete_workspace_document: '删除',
}

const AUTHORIZATION_SCOPE_LABEL: Record<WorkspaceAiAuthorizationRecord['scope'], string> = {
  action: '本次操作',
  document: '该文档',
  workspace: '当前工作区',
}

function formatContextUsage(
  usage: AiConversationSidebarProps['contextUsage'],
): string {
  if (
    !usage
    || !Number.isSafeInteger(usage.usedTokens)
    || usage.usedTokens < 0
  ) return '等待用量信息'
  const prefix = usage.estimated ? '约 ' : ''
  if (usage.contextWindowTokens === null
    || !Number.isSafeInteger(usage.contextWindowTokens)
    || usage.contextWindowTokens <= 0) {
    return `${prefix}${usage.usedTokens.toLocaleString('en-US')} tokens · 容量未知`
  }
  const percentage = Math.min(100, Math.max(
    0,
    Math.round((usage.usedTokens / usage.contextWindowTokens) * 100),
  ))
  return `${prefix}${percentage}% · ${usage.usedTokens.toLocaleString('en-US')} / ${usage.contextWindowTokens.toLocaleString('en-US')}`
}

function selectedTextWithin(container: HTMLElement): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const { anchorNode, focusNode } = selection
  if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) {
    return null
  }
  const text = selection.toString()
  return text.trim() ? text : null
}

function followAiOutput(list: HTMLElement, followProcess: boolean): void {
  if (followProcess) {
    for (const region of list.querySelectorAll<HTMLElement>('[data-ai-process-scroll="true"][data-ai-process-active="true"]')) {
      region.scrollTop = region.scrollHeight
    }
  }
  list.scrollTop = list.scrollHeight
}

function AiMessageMarkdown({
  markdown,
  onOpenLink,
}: {
  markdown: string
  onOpenLink?: (target: AiMessageLinkTarget) => void
}) {
  return (
    <div className="safe-readonly-markdown">
      <ReactMarkdown
        components={{
          a: ({ href, title, children, node: _node, ...linkProps }) => {
            const target = href ? classifyAiMessageLink(href) : null
            return target
              ? (
                <a
                  {...linkProps}
                  data-tooltip={title}
                  data-ai-message-copy-target={target.target}
                  data-ai-message-copy-type={target.kind === 'web' ? 'link' : 'path'}
                  href={aiMessageLinkHref(target)}
                  onClick={(event) => {
                    event.preventDefault()
                    onOpenLink?.(target)
                  }}
                >
                  {children}
                </a>
              )
              : <span>{children}</span>
          },
          img: () => null,
        }}
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{
          handlers: {
            link: (state, node) => {
              // Preserve the parsed target until classification: URL normalization
              // would otherwise encode literal path characters such as spaces/%.
              const element = {
                type: 'element' as const,
                tagName: 'a',
                properties: { href: node.url, ...(node.title ? { title: node.title } : {}) },
                children: state.all(node),
              }
              state.patch(node, element)
              return element
            },
          },
        }}
        skipHtml
        urlTransform={(url) => {
          const target = classifyAiMessageLink(url)
          return target?.target
        }}
      >
        {linkifyAiMessageLocalPaths(markdown)}
      </ReactMarkdown>
    </div>
  )
}

function AiOperationPath({
  path,
  onOpenLink,
}: {
  path: string
  onOpenLink?: (target: AiMessageLinkTarget) => void
}) {
  const target = classifyAiMessageLink(path)
  if (!target || target.kind !== 'local') return <span>{path}</span>
  return <a
    data-ai-message-copy-target={target.target}
    data-ai-message-copy-type="path"
    href={aiMessageLinkHref(target)}
    onClick={(event) => {
      event.preventDefault()
      onOpenLink?.(target)
    }}
  >{path}</a>
}

export function AiConversationSidebar({
  draft: workspaceDraft,
  viewport,
  modelConnections = [],
  selectedModelId = null,
  modelSwitchPending = false,
  onModelChange,
  thinkingConnection, thinkingPreference, onThinkingChange,
  configurationState,
  capabilities,
  writePolicy,
  pendingAuthorization,
  authorizationRecords,
  auditRecords,
  error,
  messages,
  activeAssistantMessageId,
  timeline,
  status,
  continueRequestId = null,
  onContinueAnalysis,
  contextUsage = null,
  onClose,
  onClear,
  onOpenSettings,
  onRetryConfiguration,
  onRetrySettings,
  onSend,
  onStop,
  onCurrentDocumentAccessChange,
  onWorkspaceAccessChange,
  onWritePolicyChange,
  onAuthorizationDecision,
  onOpenLink,
}: AiConversationSidebarProps) {
  const localDraft = useRef(createAiComposerDraft())
  const draftState = workspaceDraft ?? localDraft.current
  useSyncExternalStore((listener) => subscribeAiComposerDraft(draftState, listener), () => draftState.version)
  const draft = draftState.text
  const [submissionPending, setSubmissionPending] = useState(false)
  const submissionRef = useRef(false)
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const [policyOpen, setPolicyOpen] = useState(false)
  const policyRef = useRef<HTMLDivElement>(null)
  const policyTriggerRef = useRef<HTMLButtonElement>(null)
  const [composerHeight, setComposerHeight] = useState(70)
  const [processLayoutRevision, setProcessLayoutRevision] = useState(0)
  const resizeRef = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const localViewport = useRef<WorkspaceAiViewport>({ followLatest: true, anchorMessageId: null, anchorOffset: 0, scrollTop: 0 })
  const savedViewport = viewport ?? localViewport.current
  const restoredListRef = useRef<HTMLDivElement | null>(null)
  const restoredViewportRef = useRef<WorkspaceAiViewport | null>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const messageContentRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const permissionRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const contextMenu = useOptionalContextMenu()
  const generating = status === 'starting' || status === 'streaming'
  const contextUsageText = formatContextUsage(contextUsage)
  useEffect(() => {
    if (draftState.focusRevision > 0) composerRef.current?.focus({ preventScroll: true })
  }, [draftState, draftState.focusRevision, configurationState])
  const currentDocumentAllowed = capabilities.currentDocument
  const fallbackTimeline: readonly WorkspaceAiTimelineEntry[] = [
    ...messages.map(({ id }) => ({ kind: 'message' as const, messageId: id })),
    ...authorizationRecords
      .filter(({ allowed }) => allowed !== null)
      .map(({ operationId }) => ({ kind: 'authorization' as const, operationId })),
    ...auditRecords
      .filter(({ action }) => action !== 'authorization-allowed' && action !== 'authorization-denied')
      .map(({ id }) => ({ kind: 'audit' as const, auditId: id })),
  ]
  const visibleTimeline = timeline && timeline.length > 0 ? timeline : fallbackTimeline
  const hasIncompleteReplies = visibleTimeline.some(entry => entry.kind === 'incomplete-message')
  const activeProcessIdentities = visibleTimeline.flatMap(entry => entry.kind === 'process' && entry.record.outcome === 'active'
    ? [entry.record.requestId] : []).join('\0')

  useLayoutEffect(() => {
    const messageList = messageListRef.current
    if (!messageList) {
      restoredListRef.current = null
      restoredViewportRef.current = null
      return
    }
    if (generating || savedViewport.followLatest) {
      if (generating) savedViewport.followLatest = true
      followAiOutput(messageList, generating)
    } else if (restoredListRef.current !== messageList || restoredViewportRef.current !== savedViewport) {
      const anchor = Array.from(messageList.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.dataset.messageId === savedViewport.anchorMessageId)
      messageList.scrollTop = anchor
        ? messageList.scrollTop + anchor.getBoundingClientRect().top - messageList.getBoundingClientRect().top - savedViewport.anchorOffset
        : savedViewport.scrollTop
    }
    restoredListRef.current = messageList
    restoredViewportRef.current = savedViewport
  }, [configurationState, messages, pendingAuthorization, generating, visibleTimeline, savedViewport, processLayoutRevision])

  useLayoutEffect(() => {
    const list = messageListRef.current
    const content = messageContentRef.current
    if (!generating || !list || !content || typeof ResizeObserver === 'undefined') return
    let active = true
    let frame: number | null = null
    // A streamed table, process panel or font layout can grow after React's
    // commit. Observe its content as well as the viewport without moving focus.
    const observer = new ResizeObserver(() => {
      if (!active || frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        if (!active) return
        savedViewport.followLatest = true
        followAiOutput(list, true)
      })
    })
    observer.observe(list)
    observer.observe(content)
    // A capped inner viewport can stay the same size while its natural-height
    // body grows after fonts or line wrapping settle, without another token.
    for (const body of list.querySelectorAll<HTMLElement>('[data-ai-process-active="true"] [data-ai-process-body="true"]')) {
      observer.observe(body)
    }
    return () => {
      active = false
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [configurationState, generating, savedViewport, activeProcessIdentities, processLayoutRevision])

  useEffect(() => {
    if (!policyOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!policyRef.current?.contains(event.target as Node)) setPolicyOpen(false)
    }
    const blur = () => setPolicyOpen(false)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('blur', blur)
    }
  }, [policyOpen])

  useLayoutEffect(() => {
    if (!restoreFocusRef.current) return
    if (pendingAuthorization) return
    restoreFocusRef.current = false
    const focusTarget = composerRef.current ?? permissionRef.current
    focusTarget?.focus({ preventScroll: true })
  }, [generating, pendingAuthorization])

  const restoreFocusAfter = (action: () => void) => {
    restoreFocusRef.current = true
    action()
  }

  const submit = async () => {
    if (!draftState.text.trim() || generating || modelSwitchPending || submissionRef.current) return
    const submission = { textRevision: draftState.textRevision, quotes: [...draftState.quotes] }
    const content = composeAiMessage(draftState.text, submission.quotes)
    if (content.length > AI_CONVERSATION_MESSAGE_MAX_CHARS) {
      setSubmissionError('正文和引用合计不能超过 48,000 个字符，请缩小引用后重试。')
      return
    }
    submissionRef.current = true
    setSubmissionPending(true)
    setSubmissionError(null)
    try {
      const sourceIds = new Set(submission.quotes.map(({ sourceId }) => sourceId))
      const accepted = submission.quotes.length
        ? await onSend(content, sourceIds.size === 1 ? submission.quotes[0]!.sourceId : null)
        : await onSend(content)
      if (accepted) acceptAiComposerSubmission(draftState, submission)
      else setSubmissionError('消息未受理，请重试。')
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '消息未受理，请重试。')
    } finally {
      submissionRef.current = false
      setSubmissionPending(false)
    }
    savedViewport.followLatest = true
    const messageList = messageListRef.current
    if (messageList) messageList.scrollTop = messageList.scrollHeight
  }

  const submitForm = (event: FormEvent) => {
    event.preventDefault()
    void submit()
  }

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key !== 'Enter'
      || event.shiftKey
      || event.nativeEvent.isComposing
      || event.nativeEvent.keyCode === 229
    ) return
    event.preventDefault()
    void submit()
  }

  const openCopyMenu = (
    event: ReactMouseEvent<HTMLElement>,
    label: '复制' | '复制链接' | '复制路径',
    content: string,
  ) => {
    if (!contextMenu) return
    event.preventDefault()
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    contextMenu.openMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{ kind: 'command', id: 'copy', label }],
      execute: async (id) => {
        if (id !== 'copy') return
        try {
          await navigator.clipboard?.writeText(content)
        } catch {
          // Clipboard access can be denied without affecting the selected message text.
        }
      },
      restoreFocus: () => active?.focus({ preventScroll: true }),
      rootIconGutter: 'none',
      widthCssPx: 132,
    })
  }

  const handleMessageContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const selected = selectedTextWithin(event.currentTarget)
    if (selected) {
      openCopyMenu(event, '复制', selected)
      return
    }
    const copyTarget = (event.target as Element | null)?.closest<HTMLElement>(
      '[data-ai-message-copy-target]',
    )
    const content = copyTarget?.dataset.aiMessageCopyTarget
    if (copyTarget && event.currentTarget.contains(copyTarget) && content) {
      openCopyMenu(
        event,
        copyTarget.dataset.aiMessageCopyType === 'path' ? '复制路径' : '复制链接',
        content,
      )
    }
  }

  if (configurationState === 'checking' && !generating) {
    return (
      <section className="ai-conversation-sidebar is-unconfigured">
        <div className="ai-conversation-empty" role="status">
          <strong>正在检查 AI 对话配置…</strong>
        </div>
      </section>
    )
  }

  if (configurationState === 'unconfigured' && !generating) {
    return (
      <section className="ai-conversation-sidebar">
        <div className="model-configuration-region">
          <ModelConfigurationNotice onConfigure={onOpenSettings} onDismiss={onClose} role="status" />
        </div>
        <div className="model-configuration-footer-space" aria-hidden="true" />
      </section>
    )
  }

  if (configurationState === 'error' && !generating) {
    return (
      <section className="ai-conversation-sidebar is-unconfigured">
        <div className="ai-conversation-empty" role="status">
          <strong>无法检查 AI 对话配置</strong>
          <p>请检查设置服务后重试。</p>
          <button className="ai-conversation-primary" onClick={onRetryConfiguration} type="button">
            重试
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="ai-conversation-sidebar">
      <header className="ai-conversation-toolbar">
        <div className="ai-conversation-read-controls">
          <button
            ref={permissionRef}
            aria-label="让 AI 查看文档"
            data-tooltip="让 AI 查看文档"
            aria-pressed={currentDocumentAllowed}
            className="ai-conversation-access"
            onClick={() => onCurrentDocumentAccessChange(!currentDocumentAllowed)}
            type="button"
          >
            <AppIcon name="ai-document" size={18} />
          </button>
          <button
            aria-label="让 AI 查看工作区"
            data-tooltip="让 AI 查看工作区"
            aria-pressed={capabilities.workspace}
            className="ai-conversation-access"
            onClick={() => onWorkspaceAccessChange(!capabilities.workspace)}
            type="button"
          >
            <AppIcon name="ai-workspace" size={18} />
          </button>
        </div>
        <button
          aria-label="清空对话"
          className="ai-conversation-clear"
          disabled={messages.length === 0 && !hasIncompleteReplies && !generating && !draft && draftState.quotes.length === 0}
          onClick={onClear}
          type="button"
        >
          清空
        </button>
      </header>

      <div
        aria-label="AI 对话消息"
        aria-live="polite"
        className="ai-conversation-messages"
        ref={messageListRef}
        role="log"
        onContextMenu={handleMessageContextMenu}
        onScroll={(event) => {
          const list = event.currentTarget
          savedViewport.followLatest = list.scrollHeight - list.scrollTop - list.clientHeight <= 64
          savedViewport.scrollTop = list.scrollTop
          const top = list.getBoundingClientRect().top
          const anchor = Array.from(list.querySelectorAll<HTMLElement>('[data-message-id]'))
            .find((element) => element.getBoundingClientRect().bottom > top)
          savedViewport.anchorMessageId = anchor?.dataset.messageId ?? null
          savedViewport.anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0
        }}
      >
        <div className="ai-conversation-message-content" ref={messageContentRef}>
        {configurationState !== 'configured' && (
          <p className="ai-conversation-hint" role="status">
            {configurationState === 'checking'
              ? '正在检查 AI 对话配置…'
              : configurationState === 'error'
                ? '无法检查 AI 对话配置'
                : '当前 AI 对话模型未配置'}
          </p>
        )}
        {messages.length === 0 && !pendingAuthorization && !hasIncompleteReplies && (
          <p className="ai-conversation-hint">询问问题，或让 AI 在获得授权后查看当前文档。</p>
        )}
        {visibleTimeline.map((entry) => {
          if (entry.kind === 'incomplete-omission') return <p className="ai-conversation-operation-record" key="incomplete-omission">
            较早的未完成回复已省略，仅保留最近 20 条。
          </p>
          if (entry.kind === 'incomplete-message') return <article aria-label="AI 未完成回复"
            className="ai-conversation-message is-assistant" data-message-id={entry.message.id} key={`incomplete:${entry.message.id}`}>
            <span className="ai-conversation-message-role">AI</span>
            <p className="ai-conversation-operation-record">回复未完成 · {entry.outcome === 'failed' ? '生成失败' : entry.outcome === 'paused' ? '达到本段额度' : '已停止生成'}</p>
            <AiMessageMarkdown markdown={entry.message.content} onOpenLink={onOpenLink} />
          </article>
          if (entry.kind === 'budget-pause') return <AiBudgetNotice record={entry.record} key={`budget:${entry.record.requestId}`}
            disabled={generating || modelSwitchPending || submissionPending || configurationState !== 'configured'}
            onContinue={continueRequestId === entry.record.requestId ? onContinueAnalysis : undefined} />
          if (entry.kind === 'process') {
            const timing = visibleTimeline.find(item => item.kind === 'elapsed' && item.requestId === entry.record.requestId)
            const elapsed = timing?.kind === 'elapsed' ? timing : undefined
            const thinking = visibleTimeline.filter((item): item is AiThinkingRecord =>
              item.kind === 'thinking' && (elapsed?.messageIds.includes(item.messageId) ?? false))
            return <AiProcessPanel key={`process:${entry.record.requestId}`} record={entry.record}
              elapsed={elapsed} thinking={thinking.length > 0 ? thinking : undefined}
              onExpandedChange={() => setProcessLayoutRevision(value => value + 1)} />
          }
          if (entry.kind === 'elapsed') {
            if (visibleTimeline.some(item => item.kind === 'process' && item.record.requestId === entry.requestId)) return null
            const hasThinking = visibleTimeline.some(item => item.kind === 'thinking' && entry.messageIds.includes(item.messageId))
            return hasThinking ? null : <AiRequestTime key={`elapsed:${entry.requestId}`} record={entry} />
          }
          if (entry.kind === 'thinking') {
            const timing = visibleTimeline.find(item => item.kind === 'elapsed' && item.messageIds.includes(entry.messageId))
            if (timing?.kind === 'elapsed' && visibleTimeline.some(item => item.kind === 'process' && item.record.requestId === timing.requestId)) return null
            const lastThinking = timing?.kind === 'elapsed'
              ? visibleTimeline.filter(item => item.kind === 'thinking' && timing.messageIds.includes(item.messageId)).at(-1)
              : undefined
            return <div className="ai-conversation-timing-row" key={`thinking:${entry.messageId}`}>
              <AiThinkingTime record={entry} />
              {lastThinking === entry && timing?.kind === 'elapsed' && <AiRequestTime record={timing} />}
            </div>
          }
          if (entry.kind === 'message') {
            const message = messages.find(({ id }) => id === entry.messageId)
            if (!message) return null
            const hasContent = message.content.trim().length > 0
            if (
              message.role === 'assistant'
              && !hasContent
              && !(generating && message.id === activeAssistantMessageId)
            ) return null
            return <article
              aria-label={message.role === 'user' ? '你的消息' : 'AI 消息'}
              className={`ai-conversation-message is-${message.role}`}
              data-message-id={message.id}
              key={`message:${message.id}`}
            >
              <span className="ai-conversation-message-role">
                {message.role === 'user' ? '你' : 'AI'}
              </span>
              {message.role === 'assistant'
                ? (
                  hasContent
                    ? <AiMessageMarkdown markdown={message.content} onOpenLink={onOpenLink} />
                    : <span aria-label="AI 正在回复" className="ai-conversation-thinking">•••</span>
                )
                : <p>{message.content}</p>}
            </article>
          }
          if (entry.kind === 'authorization') {
            const record = authorizationRecords.find(({ operationId }) => (
              operationId === entry.operationId
            ))
            if (!record || record.allowed === null) return null
            return <p
              className="ai-conversation-operation-record"
              key={`authorization:${record.operationId}`}
            >
              {AUTHORIZATION_OPERATION_LABEL[record.toolName]}
              {' · '}{AUTHORIZATION_SCOPE_LABEL[record.scope]}
              {' · '}{record.allowed ? '已允许' : '已拒绝'}
              {record.paths.length > 0 ? `：${record.paths.join('、')}` : ''}
            </p>
          }
          if (entry.kind === 'context-compaction') {
            const { record } = entry
            return <p
              aria-label="上下文压缩记录"
              className="ai-conversation-operation-record"
              key={`context-compaction:${entry.id}`}
            >
              {record.status === 'failed'
                ? '上下文压缩失败 · 已保留原上下文'
                : `上下文已压缩 · ${Math.round(record.beforeTokens / record.contextWindowTokens * 100)}% → ${Math.round(record.afterTokens / record.contextWindowTokens * 100)}%`}
            </p>
          }
          const record = auditRecords.find(({ id }) => id === entry.auditId)
          if (
            !record
            || record.action === 'authorization-allowed'
            || record.action === 'authorization-denied'
          ) return null
          if (record.action === 'renamed') {
            return <p className="ai-conversation-operation-record" key={`audit:${record.id}`}>
              已重命名：
              <AiOperationPath path={record.absolutePaths[0] ?? ''} onOpenLink={onOpenLink} />
              {' → '}
              <AiOperationPath path={record.absolutePaths[1] ?? ''} onOpenLink={onOpenLink} />
            </p>
          }
          const label = record.action === 'edited'
            ? '已修改'
            : record.action === 'created' ? '已创建' : '已移至回收站'
          return <p className="ai-conversation-operation-record" key={`audit:${record.id}`}>
            {label}：
            <AiOperationPath path={record.absolutePaths[0] ?? ''} onOpenLink={onOpenLink} />
          </p>
        })}

        {pendingAuthorization && (
          <div
            aria-label="AI 写入许可申请"
            className="ai-conversation-tool-request"
            role="group"
          >
            <strong>AI 写入许可申请</strong>
            <p>
              {pendingAuthorization.scope === 'workspace'
                ? '允许当前会话内AI对工作区文档进行编辑与操作。'
                : pendingAuthorization.scope === 'document'
                  ? '允许当前会话内AI对该文档进行编辑。'
                  : '允许 AI 执行本次写入操作。'}
            </p>
            {pendingAuthorization.paths.length > 0 && (
              <p className="ai-conversation-operation-paths">
                {pendingAuthorization.paths.join('、')}
              </p>
            )}
            {pendingAuthorization.decisionPending && (
              <p role="status">正在提交许可决定…</p>
            )}
            <div className="ai-conversation-tool-actions">
              <button
                disabled={pendingAuthorization.decisionPending}
                onClick={() => restoreFocusAfter(() => onAuthorizationDecision(true))}
                type="button"
              >
                允许
              </button>
              <button
                disabled={pendingAuthorization.decisionPending}
                onClick={() => restoreFocusAfter(() => onAuthorizationDecision(false))}
                type="button"
              >
                拒绝
              </button>
            </div>
          </div>
        )}
        </div>
      </div>

      <footer className="ai-conversation-composer-wrap">
          <div aria-label="调整 AI 输入框高度" aria-orientation="horizontal" aria-valuemin={36} aria-valuemax={240}
            aria-valuenow={composerHeight} className="ai-conversation-composer-resize" role="separator" tabIndex={0}
            onKeyDown={(event) => {
              const next = event.key === 'Home' ? 36 : event.key === 'End' ? 240
                : event.key === 'ArrowUp' ? composerHeight + 10 : event.key === 'ArrowDown' ? composerHeight - 10 : null
              if (next === null) return
              event.preventDefault()
              setComposerHeight(Math.max(36, Math.min(240, next)))
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              resizeRef.current = { pointerId: event.pointerId, y: event.clientY, height: composerHeight }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const resize = resizeRef.current
              if (resize?.pointerId !== event.pointerId) return
              setComposerHeight(Math.max(36, Math.min(240, resize.height + resize.y - event.clientY)))
            }}
            onPointerUp={(event) => {
              resizeRef.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onLostPointerCapture={() => { resizeRef.current = null }}
            onPointerCancel={() => { resizeRef.current = null }}
          />

        {(error || submissionError) && <p className="ai-conversation-error" role="alert">{error || submissionError}</p>}
        {onRetrySettings && <div className="ai-conversation-settings-recovery">
          <button type="button" disabled={modelSwitchPending || generating} onClick={onRetrySettings}
            title="保留当前选择，按最新设置重试保存">重试保存设置</button>
          <button type="button" disabled={modelSwitchPending} onClick={onOpenSettings}>打开设置处理</button>
        </div>}
        <form className="ai-conversation-composer" onSubmit={submitForm}>
          {draftState.quotes.length > 0 && <div className="ai-quote-list" aria-label="待发送引用">
            {draftState.quotes.map((quote) => <AiQuoteChip key={quote.id} quote={quote} onRemove={() => {
              removeAiSelectionQuote(draftState, quote.id)
            }} />)}
          </div>}
          <textarea
            aria-label="发送消息给 AI"
            ref={composerRef}
            onChange={(event) => {
              editAiComposerDraft(draftState, event.target.value)
              setSubmissionError(null)
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="向 AI 提问…"
            rows={1}
            style={{ height: composerHeight }}
            value={draft}
          />
          <div className="ai-conversation-composer-actions">
          <div className="ai-conversation-write-policy" ref={policyRef}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPolicyOpen(false) }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !policyOpen) return
              event.preventDefault()
              event.stopPropagation()
              setPolicyOpen(false)
              policyTriggerRef.current?.focus({ preventScroll: true })
            }}>
            <button aria-label={`写入策略：${WRITE_POLICY_OPTIONS.find((option) => option.value === writePolicy)?.label}`}
              aria-expanded={policyOpen} aria-haspopup="menu" disabled={modelSwitchPending} ref={policyTriggerRef}
              onClick={() => setPolicyOpen((open) => !open)} type="button">
              <AppIcon name="permission" size={14} />
              {WRITE_POLICY_OPTIONS.find((option) => option.value === writePolicy)?.label}<AppIcon name="find-next" size={12} />
            </button>
            {policyOpen && <div className="ai-conversation-write-policy-menu" role="menu">
              <div className="preferences-select-menu-title" role="presentation">写入许可</div>
              {WRITE_POLICY_OPTIONS.map((option) => <button aria-checked={writePolicy === option.value}
                disabled={modelSwitchPending} key={option.value} role="menuitemradio" type="button" onClick={() => {
                  setPolicyOpen(false)
                  policyTriggerRef.current?.focus({ preventScroll: true })
                  onWritePolicyChange(option.value)
                }}>
                  <span className="ai-conversation-write-policy-copy">
                    <span className="ai-conversation-write-policy-label">{option.label}</span>
                    <small>{option.description}</small>
                  </span>
                  <span aria-hidden="true" className="ai-composer-menu-check">
                    {writePolicy === option.value && <AppIcon name="check" size={16} />}
                  </span>
                </button>)}
            </div>}
          </div>
          <ModelThinkingControls label="AI 对话" togglePresentation="menu" composerMenus thinkingConnection={thinkingConnection} thinkingPreference={thinkingPreference}
            onThinkingChange={onThinkingChange} thinkingPending={modelSwitchPending || generating} />
          <div className="ai-conversation-send-actions">
          {onModelChange && <div className="ai-conversation-quick-model">
            <PreferencesSelect label="AI 对话快速模型选择"
            menuTitle="选择模型" menuClassName="ai-composer-menu" optionTooltips={false}
            disabled={modelSwitchPending || generating} value={selectedModelId ?? ''}
            onChange={onModelChange} options={modelConnections.map(({ id, name }) => ({ value: id, label: name }))} /></div>}
          {generating
            ? (
              <button
                className="ai-conversation-primary ai-conversation-send"
                aria-label="停止生成"
                data-tooltip="停止生成"
                onClick={() => restoreFocusAfter(onStop)}
                type="button"
              >
                <AppIcon name="maximize" size={14} weight="fill" />
              </button>
            )
            : (
              <button
                className="ai-conversation-primary ai-conversation-send"
                aria-label="发送"
                data-tooltip="发送消息"
                disabled={!draft.trim() || submissionPending || modelSwitchPending}
                type="submit"
              >
                <AppIcon name="send-up" size={18} weight="bold" />
              </button>
            )}
          </div>
          </div>
        </form>
        <div className="ai-conversation-footer-meta">
          <p aria-label="上下文占用" className="ai-conversation-context-usage"
            title="最近一次模型请求的输入与输出用量；容量已知时显示比例，约表示本地估算。">
            {contextUsageText}
          </p>
        </div>
      </footer>
    </section>
  )
}

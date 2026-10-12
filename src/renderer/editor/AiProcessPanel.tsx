import { useEffect, useId, useState } from 'react'
import type { AiProcessEntry, AiProcessRecord, AiProcessToolRecord } from './ai-process-buffer'
import { requestElapsed, type AiRequestTime } from './ai-request-time'
import { observedThinkingElapsed, type AiThinkingTime } from './ai-thinking-time'
import type { AiProcessKind, AiProcessStage, AiProcessToolStatus } from '../../shared/ai-process-events'
import { AI_RECYCLE_UNAVAILABLE_GUIDANCE, type AiWorkspaceToolName } from '../../shared/ai-conversation'
import './ai-process-panel.css'

export interface AiProcessPanelProps {
  record: AiProcessRecord
  elapsed?: AiRequestTime
  thinking?: readonly AiThinkingTime[]
  thinkingElapsedMs?: number
  onExpandedChange?(expanded: boolean): void
}

const CHANNEL_LABELS: Record<AiProcessKind, string> = {
  'reasoning-text': '思考内容', 'reasoning-summary': '思考摘要', commentary: '进展说明',
}
const STAGE_LABELS: Record<AiProcessStage, string> = {
  'waiting-model': '等待模型响应', thinking: '正在思考', answering: '正在生成回复',
  'awaiting-approval': '等待写入许可', 'tool-running': '正在执行工具',
}
const TOOL_LABELS: Record<AiWorkspaceToolName, string> = {
  read_current_document: '读取当前文档', read_workspace_document: '读取工作区文档',
  list_workspace_entries: '列出工作区条目', edit_workspace_document: '编辑工作区文档',
  create_workspace_document: '创建工作区文档', rename_workspace_document: '重命名工作区文档',
  delete_workspace_document: '移至回收站',
}
const TOOL_STATUS_LABELS: Record<AiProcessToolStatus, string> = {
  running: '执行中', 'awaiting-approval': '等待许可', succeeded: '已完成', denied: '已拒绝',
  unavailable: '文件不可用', failed: '失败', unknown: '结果待确认', 'not-executed': '未执行',
}

function toolStatus(entry: AiProcessToolRecord, active: boolean): string {
  return !active && (entry.status === 'running' || entry.status === 'awaiting-approval')
    ? '未收到结果' : TOOL_STATUS_LABELS[entry.status]
}

/** A view of accepted process facts. Lifecycle, retention and scrolling belong to its owners. */
export function AiProcessPanel({ record, elapsed, thinking, thinkingElapsedMs, onExpandedChange }: AiProcessPanelProps) {
  const contentId = useId()
  const [, repaint] = useState(0)
  const active = record.outcome === 'active'
  const expanded = record.userExpanded ?? record.outcome !== 'completed'

  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = () => repaint(value => value + 1)
    const visibilityChanged = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      if (!document.hidden) {
        refresh()
        timer = setInterval(refresh, 1_000)
      }
    }
    visibilityChanged()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      if (timer !== undefined) clearInterval(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [active, record.requestId])

  const now = active ? performance.now() : record.endedAt ?? record.startedAt
  const totalMs = elapsed ? requestElapsed(elapsed, now) : Math.max(0, now - record.startedAt)
  const thinkingMs = thinking === undefined ? thinkingElapsedMs
    : thinking.reduce((sum, entry) => sum + observedThinkingElapsed(entry, now), 0)
  const awaitingApproval = record.stage === 'awaiting-approval' || record.entries.some(entry =>
    entry.type === 'tool' && entry.round === record.round && entry.status === 'awaiting-approval')
  const recycleUnavailable = record.entries.some(entry => entry.type === 'tool'
    && entry.toolName === 'delete_workspace_document' && entry.status === 'failed'
    && entry.reason === 'recycle-unavailable')
  const quiet = active && !awaitingApproval && now - record.lastSemanticProgressAt >= 15_000
  // Absence is known only after this request ends. Omitted history cannot prove
  // that no text arrived, and an activity signal never proves model capability.
  const absentReadableThinking = !active && thinkingMs !== undefined && !record.omitted
    && !record.entries.some(entry => entry.type === 'text' && entry.channel !== 'commentary')
  const stage = STAGE_LABELS[record.stage]
  const status = active ? stage : record.outcome === 'completed' ? '已完成'
    : record.outcome === 'paused' ? '已暂停 · 达到本段额度'
      : `${record.outcome === 'failed' ? '已失败' : '已停止'} · ${stage}`
  const rounds = new Map<number, AiProcessEntry[]>()
  const toolCounts = new Map<string, number>()
  for (const entry of record.entries) {
    const group = rounds.get(entry.round) ?? []
    group.push(entry)
    rounds.set(entry.round, group)
    if (entry.type === 'tool') {
      const label = toolStatus(entry, active)
      toolCounts.set(label, (toolCounts.get(label) ?? 0) + 1)
    }
  }

  return <section className="ai-process-panel" aria-label="处理过程" aria-live="off">
    <button className="ai-process-toggle" type="button" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => {
        record.userExpanded = !expanded
        repaint(value => value + 1)
        onExpandedChange?.(!expanded)
      }}>
      <span className="ai-process-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span>处理过程</span>
      <span className="ai-process-status" role="status" aria-live="polite" aria-atomic="true">{status}</span>
    </button>
    <div className="ai-process-times" aria-live="off">
      <span>用时 · {(Math.max(0, totalMs) / 1000).toFixed(1)}秒</span>
      {thinkingMs !== undefined && <span data-tooltip="根据收到的思考信号观测阶段耗时，不代表供应商计费时间或模型内部精确计算时间。">
        思考用时 {(Math.max(0, thinkingMs) / 1000).toFixed(1)}秒
      </span>}
    </div>
    {toolCounts.size > 0 && <p className="ai-process-summary">工具记录：{Array.from(toolCounts, ([label, count]) => `${count} 项${label}`).join('，')}</p>}
    {recycleUnavailable && <p className="ai-process-notice" role="status">{AI_RECYCLE_UNAVAILABLE_GUIDANCE}</p>}
    {quiet && <p className="ai-process-notice" role="status">暂未收到新进展，仍在等待</p>}
    {absentReadableThinking && <p className="ai-process-notice">本次未收到可展示的思考内容。</p>}
    {record.omitted && <p className="ai-process-notice">部分早期过程已省略。</p>}
    <div id={contentId} className="ai-process-content" role="region" aria-label="过程内容" aria-live="off"
      hidden={!expanded} tabIndex={expanded && record.entries.length > 0 ? 0 : undefined}
      data-ai-process-scroll="true" data-ai-process-active={active && expanded}>
      <div data-ai-process-body="true">
      {Array.from(rounds).sort(([left], [right]) => left - right).map(([round, entries]) =>
        <section className="ai-process-round" role="group" aria-label={`第 ${round} 轮`} key={round}>
          <p className="ai-process-round-title">第 {round} 轮</p>
          <ol className="ai-process-entries">
            {entries.map(entry => <li className="ai-process-entry" key={entry.id}>
              {entry.type === 'text' ? <>
                {entry.omittedBefore && <p className="ai-process-notice">此处省略了较早的过程内容。</p>}
                <div className="ai-process-entry-heading">
                  <span>{CHANNEL_LABELS[entry.channel]}</span>
                  {entry.delivery === 'complete' && <span className="ai-process-detail">结果返回时收到</span>}
                </div>
                <div className="ai-process-text">{entry.text}</div>
              </> : <>
                <div className="ai-process-entry-heading">
                  <span>{TOOL_LABELS[entry.toolName]}</span>
                  <span className="ai-process-tool-status">{toolStatus(entry, active)}</span>
                </div>
                {(entry.displayName || entry.paths.length > 0) && <span className="ai-process-target">
                  {entry.displayName ?? entry.paths.join(entry.toolName === 'rename_workspace_document' ? ' → ' : '、')}
                </span>}
                {entry.cached && <span className="ai-process-detail">复用已有结果</span>}
              </>}
            </li>)}
          </ol>
        </section>)}
      </div>
    </div>
  </section>
}

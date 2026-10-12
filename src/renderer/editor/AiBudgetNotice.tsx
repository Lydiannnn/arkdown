import { useRef, useState } from 'react'
import type { AiBudgetPausedEvent, AiBudgetStopReason } from '../../shared/ai-budget-result'
import { describeAiConversationFailure } from '../../shared/ai-failure-presentation'
import { AI_READ_TOOL_LIMIT, AI_WRITE_TOOL_LIMIT, AI_TOOL_ROUND_LIMIT } from '../../shared/ai-tool-limits'

const PAUSE_LABELS: Record<AiBudgetStopReason, string> = {
  'read-budget': '后续读取超出本段剩余次数，任务已暂停。',
  'write-budget': '后续写入超出本段剩余次数，任务已暂停。',
  'combined-budget': '本批读写操作超出本段剩余次数，任务已暂停。',
  'budgets-exhausted': '本段读写次数均已用完，任务已暂停。',
  'tool-rounds': '本段处理轮次已达上限，任务已暂停。',
}

function outcomes(values: readonly (readonly [string, number])[]): string {
  return values.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`).join('、') || '暂无已确认结果'
}

/** Trusted local settlement facts; these are not an AI answer or provider context. */
export function AiBudgetNotice({ record, disabled = false, onContinue }: {
  record: AiBudgetPausedEvent
  disabled?: boolean
  onContinue?(requestId: string): Promise<boolean>
}) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = record.outcomes
  const finalization = record.finalization
  const canContinue = Boolean(onContinue && record.continuationId)
  const includesWriteBudget = ['write-budget', 'combined-budget', 'budgets-exhausted'].includes(record.reason)
  return <section className="ai-conversation-tool-request" aria-label="分析暂停记录" data-message-id={`budget:${record.requestId}`}>
    <strong>{PAUSE_LABELS[record.reason]}</strong>
    <p>本段额度使用：读取 {record.counts.readAdmitted}/{AI_READ_TOOL_LIMIT}，写入 {record.counts.writeAdmitted}/{AI_WRITE_TOOL_LIMIT}，工具轮次 {record.counts.toolRounds}/{AI_TOOL_ROUND_LIMIT}。次数统计接纳的新调用，不代表成功处理的文件数；合法缓存回放不重复计数。</p>
    <p>读取：{outcomes([['成功', value.readSucceeded], ['失败', value.readFailed], ['未获许可', value.readDenied], ['不可用', value.readUnavailable]])}。</p>
    <p>写入：{outcomes([['成功', value.writeSucceeded], ['失败', value.writeFailed], ['未获许可', value.writeDenied], ['不可用', value.writeUnavailable], ['结果待确认', value.writeUnknown]])}。</p>
    {value.notExecuted > 0 && <p>本次被拦截的 {value.notExecuted} 次工具调用未执行。</p>}
    {value.writeUnknown > 0 ? <p>有写入结果尚未确认，请先核查结果，避免重复修改。请核对受影响文档，不要盲目重发整条改文命令。</p>
      : (includesWriteBudget || value.writeSucceeded > 0) && <p>先核对已完成的修改，再处理剩余部分。成功修改当前编辑器不代表已保存到磁盘。</p>}
    <p>{finalization.status === 'failed' ? `本段小结未能完成：${describeAiConversationFailure(finalization)}`
      : finalization.status === 'completed' ? '本段小结已返回。'
        : finalization.status === 'context-limit' ? '剩余上下文不足，未生成本段小结。'
          : '模型在收尾时仍请求工具，额外调用未执行。'}</p>
    {finalization.status === 'context-limit' && <p>{describeAiConversationFailure({ code: 'AI_CONTEXT_LIMIT_REACHED' })}</p>}
    {canContinue ? <p>{value.writeUnknown > 0 ? '核查结果后，' : ''}点击“继续分析”可开启新一段，保留已确认的操作结果，接着处理剩余任务；必要时会重新读取并核对当前文件版本。</p>
      : <p>当前没有可直接继续的有效记录。请先核对已有结果，再在输入框只提交剩余任务。</p>}
    {record.reason === 'tool-rounds' ? <p>若反复暂停，请缩小任务范围、明确希望完成的步骤，避免反复检查同一批文件。</p>
      : includesWriteBudget ? <p>若经常暂停，请把任务拆成明确的小批次，例如每次修改 3–5 份指定文档，确认结果后继续。</p>
        : <><p>已返回的结果保留。若经常暂停，请指定文件名、子文件夹或章节，分批处理，避免重复扫描整个工作区。</p>
          <p>例如：先只分析“项目说明.md”和“验收清单.md”，列出尚需查看的文件，再决定下一批。</p></>}
    {onContinue && record.continuationId && <div className="ai-conversation-tool-actions">
      <button type="button" disabled={disabled || pending} onClick={async () => {
        if (disabled || pendingRef.current) return
        pendingRef.current = true
        setPending(true)
        setError(null)
        try {
          // False can follow backend admission and local cancellation; it does not prove no operations began.
          if (!await onContinue(record.requestId)) setError('本次继续未能保持运行。请核对已有结果、当前模型和访问许可；需要另发请求时，只提交剩余任务。')
        }
        catch { setError('本次继续未能保持运行。请先核对已有结果、当前模型、访问许可和连接；需要另发请求时，只提交剩余任务。') }
        finally { pendingRef.current = false; setPending(false) }
      }}>继续分析</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>
}

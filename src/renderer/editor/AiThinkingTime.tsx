import { useEffect, useState } from 'react'
import { observedThinkingElapsed, type AiThinkingTime as ThinkingRecord } from './ai-thinking-time'

export function AiThinkingTime({ record }: { record: ThinkingRecord }) {
  const [, refresh] = useState(0)
  useEffect(() => {
    if (!record.active) return
    const timer = setInterval(() => refresh(value => value + 1), 100)
    return () => clearInterval(timer)
  }, [record.active, record.messageId])
  const seconds = (observedThinkingElapsed(record) / 1000).toFixed(1)
  return <p
    className="ai-conversation-operation-record ai-conversation-thinking-time"
    data-tooltip="根据收到的思考信号观测阶段耗时，不代表供应商计费时间或模型内部精确计算时间。"
  >{record.active ? `思考中 · ${seconds}秒` : `思考用时 ${seconds}秒`}</p>
}

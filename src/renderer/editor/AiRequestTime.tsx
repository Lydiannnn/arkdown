import { useEffect, useState } from 'react'
import { requestElapsed, type AiRequestTime as RequestRecord } from './ai-request-time'

export function AiRequestTime({ record }: { record: RequestRecord }) {
  const [, refresh] = useState(0)
  useEffect(() => {
    if (!record.active) return
    const timer = setInterval(() => refresh(value => value + 1), 100)
    return () => clearInterval(timer)
  }, [record.active, record.requestId])
  return <p className="ai-conversation-operation-record ai-conversation-request-time"
    data-tooltip="从发送到结束的总用时，包含思考、授权等待和工具执行。"
  >用时 · {(requestElapsed(record) / 1000).toFixed(1)}秒</p>
}

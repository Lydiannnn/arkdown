import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiBudgetNotice } from '../../src/renderer/editor/AiBudgetNotice'
import type { AiBudgetPausedEvent } from '../../src/shared/ai-budget-result'

const record: AiBudgetPausedEvent = {
  requestId: '550e8400-e29b-41d4-a716-000000000001', type: 'budget-paused', transcriptRevision: 4,
  continuationId: '550e8400-e29b-41d4-a716-000000000002', reason: 'read-budget',
  counts: { readAdmitted: 64, writeAdmitted: 2, rejectedNewCalls: 3, toolRounds: 30 },
  outcomes: { readSucceeded: 60, readFailed: 1, readDenied: 1, readUnavailable: 2,
    writeSucceeded: 1, writeFailed: 0, writeDenied: 0, writeUnavailable: 0, writeUnknown: 1, notExecuted: 3 },
  finalization: { status: 'failed', code: 'MODEL_RATE_LIMITED', detail: { version: 1, reason: 'rate-limited', stage: 'provider', source: 'http' } },
}

describe('AiBudgetNotice', () => {
  it('distinguishes factual outcomes, unknown writes and a failed finalizer without claiming task completion', () => {
    render(<AiBudgetNotice record={record} />)
    expect(screen.getByText('后续读取超出本段剩余次数，任务已暂停。')).toBeInTheDocument()
    expect(screen.getByText(/成功 60.*失败 1.*未获许可 1.*不可用 2/)).toBeInTheDocument()
    expect(screen.getByText(/写入：成功 1.*结果待确认 1/)).toBeInTheDocument()
    expect(screen.getByText('本次被拦截的 3 次工具调用未执行。')).toBeInTheDocument()
    expect(screen.getByText(/本段小结未能完成/)).toBeInTheDocument()
    expect(screen.getByText(/请先核查结果，避免重复修改/)).toBeInTheDocument()
    expect(screen.queryByText(/^已完成$/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续分析' })).not.toBeInTheDocument()
  })
  it('does not claim an exhausted counter when a whole batch exceeds the remaining allowance', () => {
    render(<AiBudgetNotice record={{ ...record, counts: { ...record.counts, readAdmitted: 254 } }} />)
    expect(screen.getByText('后续读取超出本段剩余次数，任务已暂停。')).toBeInTheDocument()
    expect(screen.queryByText(/已用完/)).not.toBeInTheDocument()
    expect(screen.getByText(/读取 254\/256/)).toBeInTheDocument()
  })
  it.each(['completed', 'tools-returned', 'context-limit'] as const)('explains %s finalization using local facts', status => {
    render(<AiBudgetNotice record={{ ...record, finalization: { status } }} />)
    const text = status === 'completed' ? '本段小结已返回。' : status === 'tools-returned'
      ? '模型在收尾时仍请求工具，额外调用未执行。' : '剩余上下文不足，未生成本段小结。'
    expect(screen.getByText(text)).toBeInTheDocument()
  })
  it('offers scoped reading and a fresh segment only when direct continuation is available', () => {
    const value = { ...record, counts: { ...record.counts, readAdmitted: 254 }, outcomes: { ...record.outcomes, writeUnknown: 0 } }
    render(<AiBudgetNotice record={value} onContinue={async () => true} />)
    expect(screen.getByText(/读取 254\/256.*写入 2\/16.*工具轮次 30\/80/)).toBeInTheDocument()
    expect(screen.getByText(/开启新一段.*保留已确认.*重新读取.*版本/)).toBeInTheDocument()
    expect(screen.getByText(/文件名、子文件夹或章节/)).toBeInTheDocument()
    expect(screen.getByText(/项目说明.md.*验收清单.md/)).toBeInTheDocument()
    expect(screen.queryByText(/已达到 256/)).not.toBeInTheDocument()
  })
  it.each(['write-budget', 'combined-budget', 'budgets-exhausted'] as const)('prioritizes write verification before %s continuation and suggests bounded batches', reason => {
    render(<AiBudgetNotice record={{ ...record, reason }} onContinue={async () => true} />)
    const paragraphs = screen.getByRole('region', { name: '分析暂停记录' }).querySelectorAll('p')
    const messages = Array.from(paragraphs, p => p.textContent || '')
    expect(messages.findIndex(text => text.includes('请先核查结果'))).toBeLessThan(messages.findIndex(text => text.includes('开启新一段')))
    expect(screen.getByText(/每次修改 3–5 份指定文档/)).toBeInTheDocument()
    expect(screen.getByText(/不要盲目重发整条改文命令/)).toBeInTheDocument()
    expect(screen.queryByText(/所有文件已保存/)).not.toBeInTheDocument()
  })
  it('guides a round pause without treating remaining read and write counts as exhausted', () => {
    render(<AiBudgetNotice record={{ ...record, reason: 'tool-rounds', counts: { ...record.counts, toolRounds: 80 } }} onContinue={async () => true} />)
    expect(screen.getByText('本段处理轮次已达上限，任务已暂停。')).toBeInTheDocument()
    expect(screen.getByText(/明确希望完成的步骤.*反复检查/)).toBeInTheDocument()
    expect(screen.queryByText(/读写.*已用完/)).not.toBeInTheDocument()
  })
  it.each([null, record.continuationId])('guides remaining-task input when a direct continuation is unavailable (%s)', continuationId => {
    render(<AiBudgetNotice record={{ ...record, continuationId }} />)
    expect(screen.getByText(/没有可直接继续的有效记录.*核对已有结果.*输入框.*剩余任务/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续分析' })).not.toBeInTheDocument()
    expect(screen.queryByText(/点击.*继续分析/)).not.toBeInTheDocument()
  })
  it.each(['false', 'exception'] as const)('uses outcome-neutral guidance for a continuation %s without denying possible admitted operations', async outcome => {
    const onContinue = vi.fn(async () => {
      if (outcome === 'exception') throw new Error('PRIVATE_TRANSPORT_ERROR')
      return false
    })
    render(<AiBudgetNotice record={record} onContinue={onContinue} />)
    fireEvent.click(screen.getByRole('button', { name: '继续分析' }))
    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent(/本次继续未能保持运行.*核对已有结果.*访问许可.*剩余任务/)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/未开始|未执行|已失效|已过期|自动|重发|重试|PRIVATE_TRANSPORT_ERROR/)
    expect(onContinue).toHaveBeenCalledOnce()
  })
  it('guards a repeated continuation click and keeps it disabled during model changes', async () => {
    let finish!: (accepted: boolean) => void
    const onContinue = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const view = render(<AiBudgetNotice record={record} onContinue={onContinue} />)
    const button = screen.getByRole('button', { name: '继续分析' })
    fireEvent.click(button); fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledOnce()
    expect(onContinue).toHaveBeenCalledWith(record.requestId)
    expect(button).toBeDisabled()
    await act(async () => { finish(false) })
    expect(button).not.toBeDisabled()
    view.rerender(<AiBudgetNotice record={record} onContinue={onContinue} disabled />)
    expect(button).toBeDisabled()
  })
})

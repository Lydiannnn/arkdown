import { randomUUID } from 'node:crypto'
import { APP_UPDATE_WEBSITE, type UpdateChannel, type UpdateEventType } from '../../shared/app-update'
import { requestBoundedUpdateJson, type UpdateTransport } from './update-http'

/** Best effort, current installed version only. No installation UUID or durable queue. */
export class UpdateEventSender {
  private readonly abort = new AbortController()
  private readonly retries = new Set<ReturnType<typeof setTimeout>>()
  constructor(private readonly identity: { version: string; channel: UpdateChannel }, private readonly transport?: UpdateTransport) {}
  send(type: UpdateEventType): void {
    if (this.abort.signal.aborted) return
    const body = JSON.stringify({ eventId: randomUUID(), type, version: this.identity.version, channel: this.identity.channel })
    const attempt = async (retry: boolean): Promise<void> => {
      const result = await requestBoundedUpdateJson(new URL('api/v1/events', APP_UPDATE_WEBSITE).href,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, this.abort.signal, this.transport)
      if (!retry && !this.abort.signal.aborted && (!result || (result.status >= 500 && result.status <= 599))) {
        const timer = setTimeout(() => { this.retries.delete(timer); void attempt(true) }, 1000)
        timer.unref?.(); this.retries.add(timer)
      }
    }
    void attempt(false)
  }
  dispose(): void { this.abort.abort(); for (const timer of this.retries) clearTimeout(timer); this.retries.clear() }
}

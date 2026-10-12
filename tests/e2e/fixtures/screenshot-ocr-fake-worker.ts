interface FakeRequest {
  type: 'recognize'
  requestId: number
  sessionId: string
  generation: number
  image: { width: number; height: number; bytes: ArrayBuffer }
  tier: 'small'
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(value: unknown): void
}

scope.onmessage = ({ data }) => {
  const request = data as FakeRequest
  if (request?.type !== 'recognize') return
  const width = request.image.width
  const height = request.image.height
  const first = { x: 0, y: 0, width: Math.max(1, Math.min(width, Math.ceil(width / 2))), height: Math.max(1, Math.min(height, Math.ceil(height / 2))) }
  const second = { x: Math.max(0, Math.floor(width / 2)), y: Math.max(0, Math.floor(height / 2)), width: Math.max(1, width - Math.floor(width / 2)), height: Math.max(1, height - Math.floor(height / 2)) }
  scope.postMessage({
    type: 'result',
    requestId: request.requestId,
    sessionId: request.sessionId,
    generation: request.generation,
    ok: true,
    result: {
      width,
      height,
      language: 'mul',
      blocks: [
        { id: 'line-1', text: 'Codex', rectPx: first, words: [{ text: 'Codex', rectPx: first }] },
        { id: 'line-2', text: '中英混合', rectPx: second, words: [{ text: '中英混合', rectPx: second }] },
      ],
    },
  })
}

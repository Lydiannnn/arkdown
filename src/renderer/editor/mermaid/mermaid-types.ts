import type { EditorTheme } from '../../../shared/editor-appearance-preferences'

export const MERMAID_VERSION = '11.17.2'
export const MERMAID_MAX_SOURCE_LENGTH = 20_000
export const MERMAID_MAX_EDGES = 100
export const MERMAID_MAX_SVG_BYTES = 2 * 1024 * 1024
export const MERMAID_MAX_BLOCKS = 30
export const MERMAID_RENDER_BUDGET_MS = 2_500
export const MERMAID_QUEUE_LIMIT = 10
export const MERMAID_PRINT_BATCH_BUDGET_MS = 15_000
export const MERMAID_CACHE_MAX_ENTRIES = 32
export const MERMAID_CACHE_MAX_BYTES = 8 * 1024 * 1024
export const MERMAID_ERROR_SUMMARY_MAX_LENGTH = 500

export interface MermaidAppearance {
  revision: number
  editorTheme: EditorTheme
  colorScheme: 'light' | 'dark'
  themeColor: string
  bodyFontFamily: string
}

export interface MermaidRenderRequest {
  instanceId: string
  generation: number
  source: string
  appearance: MermaidAppearance
  signal: AbortSignal
}

export type MermaidSyntaxErrorSummary =
  | { kind: 'line'; line: number }
  | { kind: 'unknown-diagram' }
  | { kind: 'generic' }

export type MermaidRenderResult =
  | { status: 'ready'; dataUrl: string }
  | { status: 'syntax-error'; message: string; summary: MermaidSyntaxErrorSummary }
  | { status: 'resource-error'; code: 'SOURCE_LIMIT' | 'EDGE_LIMIT' | 'SVG_LIMIT' | 'TIMEOUT' | 'QUEUE_LIMIT'; message: string }

export interface MermaidRenderer {
  render(request: MermaidRenderRequest): Promise<MermaidRenderResult>
}

export interface MermaidRenderable {
  preparePrint(freezeAfterPrint: boolean): void
  refresh(reason: 'source' | 'theme' | 'print'): void
  finishPrintTimeout(): void
}

export interface MermaidRegistryPort {
  appearance(): MermaidAppearance
  register(view: MermaidRenderable): () => void
  subscribeCapacityAvailable?(listener: () => void): () => void
  track(instanceId: string, generation: number, task: Promise<unknown>): void
  refreshAppearance(next: MermaidAppearance): void
  renderAll(deadlineEpochMs?: number): Promise<void>
  whenIdle(): Promise<void>
  dispose(): void
}

export function isMermaidLanguage(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'mermaid'
}

import { parseScreenshotOcrBlocks } from '../../../src/shared/screenshot-translation'

interface ValidateStartedNativeSourceInput<TChild, TMetadata> {
  child: TChild
  cleanup: (child: TChild) => Promise<void>
  readFirstLine: () => Promise<string>
  validate: (value: unknown) => value is TMetadata
}

export interface WindowsOcrEvidence {
  language: string
  status: 'completed'
  blockCount: number
  wordCount: number
}

export type ScreenshotOcrFixtureKind = 'english-small' | 'mixed-cjk-latin' | 'cancellation'

export interface ScreenshotOcrFixture {
  height: number
  html: string
  width: number
}

const SCREENSHOT_OCR_FIXTURES: Readonly<Record<ScreenshotOcrFixtureKind, ScreenshotOcrFixture>> = {
  'english-small': {
    width: 112,
    height: 56,
    html: '<main>Codex</main>',
  },
  'mixed-cjk-latin': {
    width: 420,
    height: 160,
    html: '<main><div>Codex 8172</div><div lang="zh-CN">中英混合</div></main>',
  },
  cancellation: {
    width: 720,
    height: 420,
    html: `<main>${Array.from({ length: 24 }, (_, index) => (
      `<div>OCR cancellation ${String(index + 1).padStart(2, '0')} 中英混合</div>`
    )).join('')}</main>`,
  },
}

export function screenshotOcrFixture(kind: ScreenshotOcrFixtureKind): ScreenshotOcrFixture {
  const fixture = SCREENSHOT_OCR_FIXTURES[kind]
  const fontSize = kind === 'english-small' ? 12 : kind === 'mixed-cjk-latin' ? 30 : 18
  return {
    ...fixture,
    html: `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#fff}
      body{display:flex;align-items:center;justify-content:center;color:#000;font:${fontSize}px/1.35 "Segoe UI","Microsoft YaHei UI",sans-serif}
      main{width:100%;padding:6px;text-align:center}main>div{white-space:nowrap}
    </style>${fixture.html}`,
  }
}

export function parseLocalPaddleOcrEvidence(
  value: unknown,
  expectedMarkers: readonly string[],
  forbiddenMarkers: readonly string[] = [],
): WindowsOcrEvidence {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) {
    throw new Error('Invalid local OCR evidence')
  }
  const texts: string[] = []
  for (const block of value) {
    if (!exactOwnKeys(block, ['id', 'text'])
      || typeof block.id !== 'string' || !/^line-[1-9][0-9]*$/u.test(block.id)
      || typeof block.text !== 'string' || block.text.length === 0 || block.text.length > 8192
      || block.text.normalize('NFC') !== block.text
      || /[\u0000-\u001f\u007f-\u009f]/u.test(block.text)) {
      throw new Error('Invalid local OCR evidence')
    }
    texts.push(block.text)
  }
  const text = texts.join('\n')
  if (expectedMarkers.some((marker) => !text.includes(marker))
    || forbiddenMarkers.some((marker) => text.includes(marker))) {
    throw new Error('Local OCR evidence did not satisfy the redacted fixture oracle')
  }
  return {
    language: 'mul',
    status: 'completed',
    blockCount: texts.length,
    wordCount: texts.reduce((count, block) => count + block.split(/\s+/u).filter(Boolean).length, 0),
  }
}

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

export function parseWindowsOcrEvidence(value: unknown): WindowsOcrEvidence {
  if (!exactOwnKeys(value, ['status', 'width', 'height', 'language', 'blocks'])
    || value.status !== 'ok'
    || !Number.isSafeInteger(value.width)
    || (value.width as number) <= 0
    || !Number.isSafeInteger(value.height)
    || (value.height as number) <= 0
    || typeof value.language !== 'string'
    || value.language.length === 0
    || value.language.length > 64
    || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(value.language)) {
    throw new Error('Invalid Windows OCR evidence')
  }
  const blocks = parseScreenshotOcrBlocks(value.blocks)
  if (!blocks) throw new Error('Invalid Windows OCR evidence')
  return {
    language: value.language,
    status: 'completed',
    blockCount: blocks.length,
    wordCount: blocks.reduce((count, block) => count + block.words.length, 0),
  }
}

export async function validateStartedNativeSource<TChild, TMetadata>({
  child,
  cleanup,
  readFirstLine,
  validate,
}: ValidateStartedNativeSourceInput<TChild, TMetadata>): Promise<TMetadata> {
  try {
    const value: unknown = JSON.parse(await readFirstLine())
    if (!validate(value)) throw new Error('Native screenshot fixture returned invalid metadata')
    return value
  } catch (error) {
    await cleanup(child)
    throw error
  }
}

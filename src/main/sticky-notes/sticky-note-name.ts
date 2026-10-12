import { STICKY_NOTE_NAME_MAX_LENGTH } from '../../shared/sticky-notes'

const DIGITS = Object.freeze(['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'])
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
const WINDOWS_INVALID_NAME_CHARACTERS = /[\u0000-\u001f\u007f<>:"/\\|?*]/u

function twoDigitChineseUpperNumber(value: number, omitLeadingOne = true): string {
  if (value < 10) return DIGITS[value]
  const tens = Math.floor(value / 10)
  const units = value % 10
  return `${tens === 1 && omitLeadingOne ? '' : DIGITS[tens]}拾${units === 0 ? '' : DIGITS[units]}`
}

export function stickyNoteChineseUpperNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9_999) {
    throw new RangeError('便签序号必须介于 1 和 9999 之间')
  }
  if (value < 100) return twoDigitChineseUpperNumber(value)

  const thousands = Math.floor(value / 1_000)
  const hundreds = Math.floor((value % 1_000) / 100)
  const remainder = value % 100
  let result = ''
  if (thousands > 0) result += `${DIGITS[thousands]}仟`
  if (hundreds > 0) {
    result += `${DIGITS[hundreds]}佰`
  } else if (thousands > 0 && remainder > 0) {
    result += '零'
  }
  if (remainder > 0) {
    if (remainder < 10 && hundreds > 0) result += '零'
    result += twoDigitChineseUpperNumber(remainder, false)
  }
  return result
}

function dateStamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('便签日期无效')
  const year = String(date.getFullYear() % 100).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

export function defaultStickyNoteName(
  date: Date,
  existingNames: readonly string[],
): string {
  const prefix = `便签${dateStamp(date)}-`
  const normalized = new Set(
    existingNames.map((name) => name.toLocaleLowerCase('zh-CN')),
  )
  for (let sequence = 1; sequence <= 9_999; sequence += 1) {
    const candidate = `${prefix}${stickyNoteChineseUpperNumber(sequence)}`
    if (!normalized.has(candidate.toLocaleLowerCase('zh-CN'))) return candidate
  }
  throw new Error('当天的默认便签名称已用完')
}

export type StickyNoteNameValidation =
  | { ok: true; name: string }
  | { ok: false; message: string }

export function validateStickyNoteName(
  value: string,
  existingNames: readonly string[],
  currentName?: string,
): StickyNoteNameValidation {
  if (value.trim() === '') return { ok: false, message: '便签名不能为空' }
  if (value !== value.trim()) {
    return { ok: false, message: '便签名不能以空格开头或结尾' }
  }
  if (value.length > STICKY_NOTE_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `便签名不能超过 ${STICKY_NOTE_NAME_MAX_LENGTH} 个字符`,
    }
  }
  if (value.endsWith('.')) return { ok: false, message: '便签名不能以句点结尾' }
  if (WINDOWS_INVALID_NAME_CHARACTERS.test(value)) {
    return { ok: false, message: '便签名不能包含 Windows 文件名非法字符' }
  }
  if (WINDOWS_RESERVED_NAME.test(value)) {
    return { ok: false, message: '该名称是 Windows 保留名称' }
  }

  const normalized = value.toLocaleLowerCase('en-US')
  const current = currentName?.toLocaleLowerCase('en-US')
  if (
    normalized !== current
    && existingNames.some((name) => name.toLocaleLowerCase('en-US') === normalized)
  ) return { ok: false, message: '便签名已存在' }

  return { ok: true, name: value }
}

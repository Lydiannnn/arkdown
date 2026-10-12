import { describe, expect, it } from 'vitest'
import {
  defaultStickyNoteName,
  stickyNoteChineseUpperNumber,
  validateStickyNoteName,
} from '../../src/main/sticky-notes/sticky-note-name'

describe('sticky note names', () => {
  it.each([
    [1, '壹'],
    [9, '玖'],
    [10, '拾'],
    [11, '拾壹'],
    [20, '贰拾'],
    [21, '贰拾壹'],
    [35, '叁拾伍'],
    [101, '壹佰零壹'],
    [110, '壹佰壹拾'],
    [1_001, '壹仟零壹'],
    [1_010, '壹仟零壹拾'],
    [9_999, '玖仟玖佰玖拾玖'],
  ] as const)('formats %s with Chinese uppercase numerals', (value, expected) => {
    expect(stickyNoteChineseUpperNumber(value)).toBe(expected)
  })

  it('uses the local date and next available sequence', () => {
    const date = new Date(2026, 6, 30, 23, 59, 59)
    expect(defaultStickyNoteName(date, [])).toBe('便签260730-壹')
    expect(defaultStickyNoteName(date, [
      '便签260730-壹',
      '便签260730-贰',
      '其他便签',
    ])).toBe('便签260730-叁')
  })

  it('matches existing generated names without case sensitivity', () => {
    const date = new Date(2026, 6, 30)
    expect(defaultStickyNoteName(date, [
      '便签260730-壹',
      '便签260730-贰',
    ].map((name) => name.toLocaleUpperCase('zh-CN')))).toBe('便签260730-叁')
  })

  it('accepts a unique Windows-safe name', () => {
    expect(validateStickyNoteName('开发记录', ['其他便签'])).toEqual({
      ok: true,
      name: '开发记录',
    })
  })

  it('allows a rename to keep its current spelling', () => {
    expect(validateStickyNoteName('Note', ['Note', '其他便签'], 'Note')).toEqual({
      ok: true,
      name: 'Note',
    })
  })

  it.each([
    ['', '便签名不能为空'],
    ['   ', '便签名不能为空'],
    [' 尾部空格', '便签名不能以空格开头或结尾'],
    ['尾部空格 ', '便签名不能以空格开头或结尾'],
    ['尾部句点.', '便签名不能以句点结尾'],
    ['a/b', '便签名不能包含 Windows 文件名非法字符'],
    ['a\\b', '便签名不能包含 Windows 文件名非法字符'],
    ['a:b', '便签名不能包含 Windows 文件名非法字符'],
    ['CON', '该名称是 Windows 保留名称'],
    ['con.txt', '该名称是 Windows 保留名称'],
    ['LPT9', '该名称是 Windows 保留名称'],
  ] as const)('rejects "%s"', (value, message) => {
    expect(validateStickyNoteName(value, [])).toEqual({ ok: false, message })
  })

  it('rejects an overlong name', () => {
    expect(validateStickyNoteName('a'.repeat(81), [])).toEqual({
      ok: false,
      message: '便签名不能超过 80 个字符',
    })
  })

  it('rejects a case-insensitive duplicate', () => {
    expect(validateStickyNoteName('note', ['Note'])).toEqual({
      ok: false,
      message: '便签名已存在',
    })
  })
})

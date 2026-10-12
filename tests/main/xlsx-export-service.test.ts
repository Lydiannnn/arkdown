import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { XlsxExportService } from '../../src/main/xlsx/xlsx-export-service'

describe('XlsxExportService', () => {
  let root = ''
  let tempRoot = ''
  let exportsRoot = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'arkdown-xlsx-export-'))
    tempRoot = path.join(root, 'temp')
    exportsRoot = path.join(root, 'exports')
    await Promise.all([mkdir(tempRoot, { recursive: true }), mkdir(exportsRoot)])
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes one 文档 sheet with lines and Markdown table cells in source order', async () => {
    const targetPath = path.join(exportsRoot, 'report.xlsx')
    const service = new XlsxExportService({ tempRoot })
    await service.export([
      'Intro',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| A | =SUM(A1:A2) |',
      'After [label](https://example.com)',
    ].join('\n'), targetPath)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(targetPath)
    expect(workbook.worksheets.map(({ name }) => name)).toEqual(['文档'])
    const sheet = workbook.getWorksheet('文档')
    expect(sheet).toBeDefined()
    expect(sheet?.rowCount).toBe(5)
    expect(Array.from({ length: 5 }, (_, index) => [
      sheet?.getCell(index + 1, 1).value,
      sheet?.getCell(index + 1, 2).value,
    ])).toEqual([
      ['Intro', null],
      ['', null],
      ['Name', 'Value'],
      ['A', '=SUM(A1:A2)'],
      ['After label', null],
    ])
    expect(sheet?.getCell(4, 2).type).toBe(ExcelJS.ValueType.String)
  })

  it('keeps the previous target and removes temporary output when workbook writing fails', async () => {
    const targetPath = path.join(exportsRoot, 'report.xlsx')
    await writeFile(targetPath, 'trusted', 'utf8')
    const writeFileFailure = vi.fn(async () => { throw new Error('write failed') })
    const service = new XlsxExportService({
      tempRoot,
      workbookFactory: () => ({
        addWorksheet: () => ({ addRow: vi.fn() }),
        xlsx: { writeFile: writeFileFailure },
      }),
    })

    await expect(service.export('new', targetPath)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    })
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('trusted')
    await expect(readdir(path.join(tempRoot, 'xlsx-export'))).resolves.toEqual([])
  })

  it('rejects non-XLSX and relative targets before constructing a workbook', async () => {
    const workbookFactory = vi.fn()
    const service = new XlsxExportService({ tempRoot, workbookFactory })
    await expect(service.export('text', path.join(exportsRoot, 'report.xls')))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    await expect(service.export('text', 'report.xlsx'))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    expect(workbookFactory).not.toHaveBeenCalled()
  })

  it('awaits a separately loaded workbook for each concurrent export', async () => {
    const workbookFactory = vi.fn(async () => new ExcelJS.Workbook())
    const service = new XlsxExportService({ tempRoot, workbookFactory })
    const paths = [path.join(exportsRoot, 'a.xlsx'), path.join(exportsRoot, 'b.xlsx')]
    await Promise.all(paths.map((target, index) => service.export(`Text ${index}`, target)))
    expect(workbookFactory).toHaveBeenCalledTimes(2)
    for (const [index, target] of paths.entries()) {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(target)
      expect(workbook.getWorksheet('文档')?.getCell(1, 1).value).toBe(`Text ${index}`)
    }
  })

  it('keeps the target and cleans up when loading the workbook fails', async () => {
    const target = path.join(exportsRoot, 'trusted.xlsx')
    await writeFile(target, 'trusted', 'utf8')
    const service = new XlsxExportService({ tempRoot, workbookFactory: async () => { throw new Error('load failed') } })
    await expect(service.export('new', target)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(await readFile(target, 'utf8')).toBe('trusted')
    expect(await readdir(path.join(tempRoot, 'xlsx-export'))).toEqual([])
  })
})

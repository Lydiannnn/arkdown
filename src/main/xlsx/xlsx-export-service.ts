import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import writeFileAtomic from 'write-file-atomic'
import { buildXlsxRows } from '../../shared/xlsx-export-model'
import { appError, PublicError } from '../../shared/public-errors'

interface WorksheetLike {
  addRow(values: string[]): unknown
}

interface WorkbookLike {
  addWorksheet(name: string): WorksheetLike
  xlsx: { writeFile(filePath: string): Promise<void> }
}

export interface XlsxExportServiceOptions {
  tempRoot: string
  workbookFactory?: () => WorkbookLike | Promise<WorkbookLike>
}

async function requireWorkbook(filePath: string): Promise<void> {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size <= 0) throw appError('OPERATION_FAILED')
}

export class XlsxExportService {
  private readonly workbookFactory: () => WorkbookLike | Promise<WorkbookLike>

  constructor(private readonly options: XlsxExportServiceOptions) {
    this.workbookFactory = options.workbookFactory ?? (async () => new (await import('exceljs')).default.Workbook())
  }

  async export(markdown: string, targetPath: string): Promise<void> {
    if (
      !path.isAbsolute(targetPath)
      || path.extname(targetPath).toLocaleLowerCase('en-US') !== '.xlsx'
    ) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }

    const operationDirectory = path.join(
      this.options.tempRoot,
      'xlsx-export',
      randomUUID(),
    )
    const workbookPath = path.join(operationDirectory, 'document.xlsx')
    try {
      await mkdir(operationDirectory, { recursive: true })
      const workbook = await this.workbookFactory()
      const worksheet = workbook.addWorksheet('文档')
      for (const row of buildXlsxRows(markdown)) {
        if (row.kind === 'line') worksheet.addRow([row.value])
        else for (const cells of row.cells) worksheet.addRow([...cells])
      }
      await workbook.xlsx.writeFile(workbookPath)
      await requireWorkbook(workbookPath)
      await writeFileAtomic(targetPath, await readFile(workbookPath), { fsync: true })
    } catch (error) {
      if (error instanceof PublicError) throw error
      throw appError('OPERATION_FAILED')
    } finally {
      await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

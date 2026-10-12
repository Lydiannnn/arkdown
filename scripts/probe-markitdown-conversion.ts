import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ComponentBuildResult } from './build-markitdown-component.ts'
import { inspectBuiltComponent } from './verify-markitdown-component.ts'

export const SUPPORTED_PROBE_FORMATS = ['pdf', 'pptx', 'xlsx', 'epub'] as const
export type ProbeFormat = typeof SUPPORTED_PROBE_FORMATS[number]
export type ProbeResult = 'pass' | 'conditional' | 'fail'

const DEFAULT_LIMITS = {
  inputBytes: 256 * 1024 * 1024,
  outputBytes: 32 * 1024 * 1024,
} as const
const STATUS_OUTPUT_LIMIT_BYTES = 64 * 1024
const FORMAT_TIMEOUTS: Readonly<Record<ProbeFormat, number>> = {
  pdf: 120_000,
  pptx: 120_000,
  xlsx: 300_000,
  epub: 120_000,
}
const ANONYMOUS_ID = /^(?:pdf|pptx|xlsx|epub)-(?:[1-9]\d*|large)$/
const APPROVED_COMPONENT = {
  version: '0.1.7-py3.12.10',
  bytes: 75_859_983,
  sha256: 'd375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec',
} as const

export interface ProbeStructureMetrics {
  kind: 'pages' | 'slides' | 'sheets' | 'chapters'
  sourceUnits: number
  coveredUnits: number
  missingUnits: number
  noTextUnits: number
  blankUnits: number
  unverifiableUnits: number
  sourceRows: number
  coveredRows: number
  sourceCells: number
  coveredCells: number
  sourceTextChars: number
  matchedTextChars: number
  expectedHeadings: number
  preservedHeadings: number
  expectedListItems: number
  preservedListItems: number
  expectedEmphasis: number
  preservedEmphasis: number
  expectedLinks: number
  preservedLinks: number
}

export const PROBE_STRUCTURE_FIELDS = [
  'kind',
  'sourceUnits',
  'coveredUnits',
  'missingUnits',
  'noTextUnits',
  'blankUnits',
  'unverifiableUnits',
  'sourceRows',
  'coveredRows',
  'sourceCells',
  'coveredCells',
  'sourceTextChars',
  'matchedTextChars',
  'expectedHeadings',
  'preservedHeadings',
  'expectedListItems',
  'preservedListItems',
  'expectedEmphasis',
  'preservedEmphasis',
  'expectedLinks',
  'preservedLinks',
] as const satisfies readonly (keyof ProbeStructureMetrics)[]

export interface ProbeSampleInput {
  id: string
  format: ProbeFormat
  sourcePath: string
  expectedUnits: number
}

export interface ProbeComponent {
  version: string
  archiveBytes: number
  archiveSha256: string
  command: string
  cliPath: string
  prefixArgs?: readonly string[]
  runtimeRoot?: string
}

export interface ProbeOptions {
  component: ProbeComponent
  samples: ProbeSampleInput[]
  operationParent?: string
  limits?: { inputBytes: number; outputBytes: number }
  signal?: AbortSignal
  inspectStructure: (
    sample: ProbeSampleInput,
    outputPath: string,
    timeoutMs?: number,
  ) => Promise<ProbeStructureMetrics>
  timeoutForFormat?: (format: ProbeFormat) => number
  onTimeoutSelected?: (timeoutMs: number, format: ProbeFormat) => void
  onArguments?: (args: readonly string[]) => void
  removeOperationDirectory?: (pathname: string) => Promise<void>
}

export interface ProbeSampleReport {
  id: string
  format: ProbeFormat
  sourceBytes: number
  outputBytes: number
  outputChars: number
  outputSha256: string | null
  textCharacters: number
  elapsedMs: number
  peakWorkingSetBytes: number | null
  exitStatus: 'exit-0' | 'exit-nonzero' | 'timeout' | 'cancelled' | 'spawn-failed' | 'output-limit' | 'status-limit'
  statusValid: boolean
  timedOut: boolean
  outputWithinLimit: boolean
  outputLimitExceeded: boolean
  statusLimitExceeded: boolean
  sourceHashUnchanged: boolean
  sourceSizeUnchanged: boolean
  sourceMtimeUnchanged: boolean
  sourceDirectoryUnchanged: boolean
  processExited: boolean
  cleanupComplete: boolean
  headings: number
  tableRows: number
  replacementCharacters: number
  structureValid: boolean
  structure: ProbeStructureMetrics
  executionResult: ProbeResult
  fidelityResult: ProbeResult
  result: ProbeResult
}

export const PROBE_SAMPLE_FIELDS = [
  'id',
  'format',
  'sourceBytes',
  'outputBytes',
  'outputChars',
  'outputSha256',
  'textCharacters',
  'elapsedMs',
  'peakWorkingSetBytes',
  'exitStatus',
  'statusValid',
  'timedOut',
  'outputWithinLimit',
  'outputLimitExceeded',
  'statusLimitExceeded',
  'sourceHashUnchanged',
  'sourceSizeUnchanged',
  'sourceMtimeUnchanged',
  'sourceDirectoryUnchanged',
  'processExited',
  'cleanupComplete',
  'headings',
  'tableRows',
  'replacementCharacters',
  'structureValid',
  'structure',
  'executionResult',
  'fidelityResult',
  'result',
] as const satisfies readonly (keyof ProbeSampleReport)[]

export interface ProbeReport {
  schemaVersion: 1
  componentVersion: string
  archiveBytes: number
  archiveSha256: string
  samples: ProbeSampleReport[]
  formats: Array<{
    format: ProbeFormat
    executionResult: ProbeResult
    fidelityResult: ProbeResult
    result: ProbeResult
  }>
  executionDecision: ProbeResult
  fidelityDecision: ProbeResult
  decision: ProbeResult
}

interface SourceSnapshot {
  bytes: number
  sha256: string
  mtimeNs: bigint
  directoryDigest: string
}

interface ProcessExit {
  code: number | null
  status: ProbeSampleReport['exitStatus']
  timedOut: boolean
  processExited: boolean
}

interface OwnedFileLimitResult {
  outputLimitExceeded: boolean
  statusLimitExceeded: boolean
}

export interface AuthorizedSampleIdentity {
  id: string
  format: ProbeFormat
  relativeNameSha256: string
}

const AUTHORIZED_SAMPLE_IDENTITIES: ReadonlyArray<AuthorizedSampleIdentity> = [
  { id: 'pdf-1', format: 'pdf', relativeNameSha256: 'aa87f500583ca0b85d7163c54a4412e251bf1887d8823eda1e54049acb948df3' },
  { id: 'pdf-2', format: 'pdf', relativeNameSha256: '6374565a7336f494993bee9683b442b3bc73d872c8cd267f91cb0c836b3af7db' },
  { id: 'pdf-3', format: 'pdf', relativeNameSha256: '0a0b5ff98c4f34a0d7f4dd7750307f36c5878508131bdb5751dd2035e7a97ed4' },
  { id: 'pptx-1', format: 'pptx', relativeNameSha256: 'a87524f0a468e60af20d9630d0c00683f6c320b9f628478b98e1b4a162ddc28c' },
  { id: 'pptx-2', format: 'pptx', relativeNameSha256: 'ace1c76cd2e6975a8d1f2314e82f0bf9fcc4525bf602a5cb52e6ac038c6957af' },
  { id: 'xlsx-1', format: 'xlsx', relativeNameSha256: '897bd7e5ca02f5782aba8d3131e989c51fb48f180da537713fedd835cc7a85bf' },
  { id: 'xlsx-large', format: 'xlsx', relativeNameSha256: 'ac390cf33e6524c93bc6fcc92a4aa1f960ced941e3a3dd99e54ef05192b1ca9c' },
]

const STRUCTURE_PROBE = String.raw`from __future__ import annotations
import json
import re
import sys
import unicodedata
from pathlib import Path

ZERO = {
    "expectedHeadings": 0, "preservedHeadings": 0,
    "expectedListItems": 0, "preservedListItems": 0,
    "expectedEmphasis": 0, "preservedEmphasis": 0,
    "expectedLinks": 0, "preservedLinks": 0,
}

def normalized(value: str) -> str:
    return "".join(ch.casefold() for ch in unicodedata.normalize("NFKC", value) if ch.isalnum())

def tokens(value: str) -> list[str]:
    return [term for term in (normalized(word) for word in re.findall(r"[^\W_]+", value, flags=re.UNICODE)) if len(term) >= 2]

def text_grams(value: str, width: int = 4) -> set[str]:
    compact = normalized(value)
    if not compact:
        return set()
    if len(compact) <= width:
        return {compact}
    return {compact[index:index + width] for index in range(len(compact) - width + 1)}

def anchored_metrics(kind: str, units: list[str], output_text: str) -> dict[str, int | str]:
    output_grams = text_grams(output_text)
    normalized_units = [normalized(unit) for unit in units]
    candidates = [text_grams(unit) for unit in units]
    occurrences: dict[str, int] = {}
    for unit_candidates in candidates:
        for candidate in unit_candidates:
            occurrences[candidate] = occurrences.get(candidate, 0) + 1
    covered = 0
    missing = 0
    no_text = 0
    unverifiable = 0
    source_text_chars = 0
    matched_text_chars = 0
    for compact, unit_candidates in zip(normalized_units, candidates):
        source_text_chars += len(compact)
        if not compact:
            no_text += 1
            continue
        unique_anchors = {candidate for candidate in unit_candidates if occurrences.get(candidate) == 1}
        if not unique_anchors:
            unverifiable += 1
        matched = len(unit_candidates & output_grams)
        ratio = matched / len(unit_candidates) if unit_candidates else 0.0
        matched_text_chars += round(len(compact) * ratio)
        if ratio >= 0.35:
            covered += 1
        else:
            missing += 1
    return {
        "kind": kind,
        "sourceUnits": len(units),
        "coveredUnits": covered,
        "missingUnits": missing,
        "noTextUnits": no_text,
        "blankUnits": 0,
        "unverifiableUnits": unverifiable,
        "sourceRows": 0,
        "coveredRows": 0,
        "sourceCells": 0,
        "coveredCells": 0,
        "sourceTextChars": source_text_chars,
        "matchedTextChars": min(source_text_chars, matched_text_chars),
        **ZERO,
    }

def pdf_units(source: Path) -> list[str]:
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer
    units: list[str] = []
    for page in extract_pages(str(source)):
        pieces: list[str] = []
        stack = list(page)
        while stack:
            item = stack.pop()
            if isinstance(item, LTTextContainer):
                pieces.append(item.get_text())
            elif hasattr(item, "__iter__"):
                stack.extend(list(item))
        units.append(" ".join(pieces))
    return units

def pptx_units(source: Path) -> list[str]:
    from pptx import Presentation
    units: list[str] = []
    for slide in Presentation(str(source)).slides:
        pieces: list[str] = []
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                pieces.append(shape.text)
            if getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    pieces.extend(cell.text for cell in row.cells)
        units.append(" ".join(pieces))
    return units

def markdown_heading_sections(output_text: str) -> dict[str, list[str]]:
    lines = output_text.splitlines()
    headings: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        match = re.match(r"^\s*#{1,6}\s+(.+?)\s*#*\s*$", line)
        if match:
            title = normalized(match.group(1))
            if title:
                headings.append((index, title))
    sections: dict[str, list[str]] = {}
    for heading_index, (line_index, title) in enumerate(headings):
        end = headings[heading_index + 1][0] if heading_index + 1 < len(headings) else len(lines)
        sections.setdefault(title, []).append("\n".join(lines[line_index + 1:end]))
    return sections

def markdown_table_rows(section: str) -> list[list[str]]:
    result: list[list[str]] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        raw_cells = [cell.strip() for cell in stripped[1:-1].split("|")]
        if raw_cells and all(re.fullmatch(r":?-{3,}:?", cell) for cell in raw_cells):
            continue
        cells = [normalized(cell) for cell in raw_cells]
        cells = [cell for cell in cells if cell]
        if cells:
            result.append(cells)
    return result

def xlsx_metrics(source: Path, output_text: str) -> dict[str, int | str]:
    from openpyxl import load_workbook
    workbook = load_workbook(source, read_only=True, data_only=False)
    sections = markdown_heading_sections(output_text)
    source_rows = 0
    covered_rows = 0
    source_cells = 0
    covered_cells = 0
    source_text_chars = 0
    matched_text_chars = 0
    covered_units = 0
    blank_units = 0
    unverifiable_units = 0
    source_units = len(workbook.sheetnames)
    try:
        for sheet in workbook.worksheets:
            rows: list[list[str]] = []
            for row in sheet.iter_rows(values_only=True):
                values = [str(value) for value in row if value is not None and str(value).strip()]
                if values:
                    rows.append(values)
            unit_rows = len(rows)
            unit_cells = sum(len(row) for row in rows)
            unit_text_chars = sum(len(normalized(value)) for row in rows for value in row)
            sheet_anchor = normalized(sheet.title)
            matching_sections = sections.get(sheet_anchor, []) if sheet_anchor else []
            unit_covered_rows = 0
            unit_covered_cells = 0
            if len(matching_sections) == 1:
                available_rows = markdown_table_rows(matching_sections[0])
                for row in rows:
                    normalized_row = [normalized(value) for value in row]
                    normalized_row = [value for value in normalized_row if value]
                    try:
                        matched_index = available_rows.index(normalized_row)
                    except ValueError:
                        continue
                    available_rows.pop(matched_index)
                    unit_covered_rows += 1
                    unit_covered_cells += len(normalized_row)
                    matched_text_chars += sum(len(value) for value in normalized_row)
            source_rows += unit_rows
            covered_rows += unit_covered_rows
            source_cells += unit_cells
            covered_cells += unit_covered_cells
            source_text_chars += unit_text_chars
            if unit_rows == 0:
                blank_units += 1
                continue
            if not sheet_anchor:
                unverifiable_units += 1
                continue
            if len(matching_sections) != 1:
                unverifiable_units += 1
                continue
            sheet_named = len(matching_sections) == 1
            if sheet_named and unit_covered_rows == unit_rows and unit_covered_cells == unit_cells:
                covered_units += 1
    finally:
        workbook.close()
    return {
        "kind": "sheets",
        "sourceUnits": source_units,
        "coveredUnits": covered_units,
        "missingUnits": source_units - covered_units - blank_units,
        "noTextUnits": 0,
        "blankUnits": blank_units,
        "unverifiableUnits": unverifiable_units,
        "sourceRows": source_rows,
        "coveredRows": covered_rows,
        "sourceCells": source_cells,
        "coveredCells": covered_cells,
        "sourceTextChars": source_text_chars,
        "matchedTextChars": min(source_text_chars, matched_text_chars),
        **ZERO,
    }

def write_atomic(destination: Path, contents: str) -> None:
    pending = destination.with_name(f".{destination.name}.probe.pending")
    pending.write_text(contents, encoding="utf-8", newline="\n")
    pending.replace(destination)

def main() -> int:
    try:
        format_name, source_name, output_name, metrics_name, status_name = sys.argv[1:6]
        source = Path(source_name)
        output_text = Path(output_name).read_text(encoding="utf-8", errors="strict")
        if format_name == "pdf":
            metrics = anchored_metrics("pages", pdf_units(source), output_text)
        elif format_name == "pptx":
            metrics = anchored_metrics("slides", pptx_units(source), output_text)
        elif format_name == "xlsx":
            metrics = xlsx_metrics(source, output_text)
        else:
            return 2
        serialized = json.dumps(metrics, separators=(",", ":"))
        write_atomic(Path(metrics_name), serialized)
        write_atomic(Path(status_name), json.dumps({"ok": True, "chars": len(serialized)}, separators=(",", ":")))
        return 0
    except Exception:
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
`

export async function writeEmbeddedStructureProbe(destination: string): Promise<void> {
  await writeFile(destination, STRUCTURE_PROBE, { encoding: 'utf8', flag: 'wx' })
}

function hashBytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function runMetadataProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.once('error', () => finish(new Error('metadata_process_failed')))
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('metadata_process_failed')))
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* close/error remains authoritative */ }
      finish(new Error('metadata_process_failed'))
    }, timeoutMs)
  })
}

async function currentOwnedArtifactBytes(filename: string): Promise<number> {
  const directory = path.dirname(filename)
  const basename = path.basename(filename)
  const pendingPrefix = `.${basename}.`
  let total = 0
  let pendingRenamed = false
  let finalCounted = false
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      !entry.isFile()
      || (entry.name !== basename && !(entry.name.startsWith(pendingPrefix) && entry.name.endsWith('.pending')))
    ) continue
    try {
      total += (await stat(path.join(directory, entry.name))).size
      if (entry.name === basename) finalCounted = true
    } catch (error) {
      if (entry.name === basename || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The writer atomically renames owned pending files between readdir and stat.
      pendingRenamed = true
    }
    if (!Number.isSafeInteger(total)) throw new Error('owned_artifact_size_invalid')
  }
  if (pendingRenamed && !finalCounted) {
    total += (await stat(filename)).size
    if (!Number.isSafeInteger(total)) throw new Error('owned_artifact_size_invalid')
  }
  return total
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): {
  completion: Promise<void>
  force: (status: 'output-limit' | 'status-limit') => void
  result: Promise<ProcessExit>
} {
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
  let force!: (status: 'output-limit' | 'status-limit') => void
  const result = new Promise<ProcessExit>((resolve) => {
    let settled = false
    let forcedStatus: ProbeSampleReport['exitStatus'] | undefined
    let fallback: NodeJS.Timeout | undefined
    const finish = (value: ProcessExit): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      signal?.removeEventListener('abort', cancel)
      resolveCompletion()
      resolve(value)
    }
    const terminate = (status: ProbeSampleReport['exitStatus']): void => {
      if (settled || forcedStatus) return
      forcedStatus = status
      try { child.kill('SIGKILL') } catch { /* close/error remains authoritative */ }
      fallback = setTimeout(() => finish({
        code: null,
        status,
        timedOut: status === 'timeout',
        processExited: false,
      }), 2_000)
    }
    force = terminate
    const cancel = (): void => terminate('cancelled')
    const timer = setTimeout(() => terminate('timeout'), timeoutMs)
    child.once('error', () => finish({
      code: null,
      status: 'spawn-failed',
      timedOut: false,
      processExited: true,
    }))
    child.once('close', (code) => finish({
      code,
      status: forcedStatus ?? (code === 0 ? 'exit-0' : 'exit-nonzero'),
      timedOut: forcedStatus === 'timeout',
      processExited: true,
    }))
    if (signal?.aborted) cancel()
    else signal?.addEventListener('abort', cancel, { once: true })
  })
  return { completion, force, result }
}

async function monitorOwnedFiles(
  outputPath: string,
  statusPath: string,
  outputLimitBytes: number,
  completion: Promise<void>,
  force: (status: 'output-limit' | 'status-limit') => void,
): Promise<OwnedFileLimitResult> {
  const result = { outputLimitExceeded: false, statusLimitExceeded: false }
  let complete = false
  void completion.then(() => { complete = true })
  while (!complete) {
    if (await currentOwnedArtifactBytes(outputPath) > outputLimitBytes) {
      result.outputLimitExceeded = true
      force('output-limit')
    } else if (await currentOwnedArtifactBytes(statusPath) > STATUS_OUTPUT_LIMIT_BYTES) {
      result.statusLimitExceeded = true
      force('status-limit')
    }
    if (!complete) {
      await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 20))])
    }
  }
  return result
}

async function runConversionProcess(input: {
  args: readonly string[]
  command: string
  cwd: string
  outputLimitBytes: number
  outputPath: string
  signal?: AbortSignal
  statusPath: string
  timeoutMs: number
}): Promise<{ exit: ProcessExit; fileLimits: OwnedFileLimitResult }> {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    windowsHide: true,
    shell: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      TEMP: input.cwd,
      TMP: input.cwd,
    },
  })
  const exit = waitForExit(child, input.timeoutMs, input.signal)
  const [result, fileLimits] = await Promise.all([
    exit.result,
    monitorOwnedFiles(
      input.outputPath,
      input.statusPath,
      input.outputLimitBytes,
      exit.completion,
      exit.force,
    ),
  ])
  return { exit: result, fileLimits }
}

function isExactStructureMetrics(value: unknown): value is ProbeStructureMetrics {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const numericKeys = [
    'sourceUnits', 'coveredUnits', 'missingUnits', 'noTextUnits', 'blankUnits', 'unverifiableUnits',
    'sourceRows', 'coveredRows', 'sourceCells', 'coveredCells',
    'sourceTextChars', 'matchedTextChars',
    'expectedHeadings', 'preservedHeadings', 'expectedListItems', 'preservedListItems',
    'expectedEmphasis', 'preservedEmphasis', 'expectedLinks', 'preservedLinks',
  ]
  if (
    Object.keys(record).sort().join(',') !== ['kind', ...numericKeys].sort().join(',')
    || !['pages', 'slides', 'sheets', 'chapters'].includes(String(record.kind))
  ) return false
  return numericKeys.every((key) => Number.isSafeInteger(record[key]) && Number(record[key]) >= 0)
}

function copyExactStructureMetrics(value: unknown, sample: ProbeSampleInput): ProbeStructureMetrics {
  if (!isExactStructureMetrics(value)) throw new Error('structure_probe_failed')
  const expectedKind = sample.format === 'pdf'
    ? 'pages'
    : sample.format === 'pptx'
      ? 'slides'
      : sample.format === 'xlsx'
        ? 'sheets'
        : 'chapters'
  if (
    value.kind !== expectedKind
    || value.sourceUnits <= 0
    || value.coveredUnits + value.missingUnits + value.noTextUnits + value.blankUnits !== value.sourceUnits
    || value.unverifiableUnits > value.sourceUnits
    || value.coveredRows > value.sourceRows
    || value.coveredCells > value.sourceCells
    || value.matchedTextChars > value.sourceTextChars
    || (sample.expectedUnits > 0 && value.sourceUnits !== sample.expectedUnits)
    || value.preservedHeadings > value.expectedHeadings
    || value.preservedListItems > value.expectedListItems
    || value.preservedEmphasis > value.expectedEmphasis
    || value.preservedLinks > value.expectedLinks
  ) throw new Error('structure_probe_failed')
  return Object.fromEntries(PROBE_STRUCTURE_FIELDS.map((field) => [field, value[field]])) as unknown as ProbeStructureMetrics
}

function emptyStructure(sample: ProbeSampleInput): ProbeStructureMetrics {
  const kind = sample.format === 'pdf'
    ? 'pages'
    : sample.format === 'pptx'
      ? 'slides'
      : sample.format === 'xlsx'
        ? 'sheets'
        : 'chapters'
  return {
    kind,
    sourceUnits: sample.expectedUnits,
    coveredUnits: 0,
    missingUnits: sample.expectedUnits,
    noTextUnits: 0,
    blankUnits: 0,
    unverifiableUnits: 0,
    sourceRows: 0,
    coveredRows: 0,
    sourceCells: 0,
    coveredCells: 0,
    sourceTextChars: 0,
    matchedTextChars: 0,
    expectedHeadings: 0,
    preservedHeadings: 0,
    expectedListItems: 0,
    preservedListItems: 0,
    expectedEmphasis: 0,
    preservedEmphasis: 0,
    expectedLinks: 0,
    preservedLinks: 0,
  }
}

export function createStructureInspector(options: {
  command: string
  prefixArgs?: readonly string[]
  probeScript: string
}) {
  return async (
    sample: ProbeSampleInput,
    markdownPath: string,
    timeoutMs = FORMAT_TIMEOUTS[sample.format],
  ): Promise<ProbeStructureMetrics> => {
    const operationDirectory = path.dirname(markdownPath)
    const metricsPath = path.join(operationDirectory, 'structure.json')
    const statusPath = path.join(operationDirectory, 'structure-status.json')
    const args = [
      ...(options.prefixArgs ?? []),
      options.probeScript,
      sample.format,
      sample.sourcePath,
      markdownPath,
      metricsPath,
      statusPath,
    ]
    const controlled = await runConversionProcess({
      args,
      command: options.command,
      cwd: operationDirectory,
      outputLimitBytes: STATUS_OUTPUT_LIMIT_BYTES,
      outputPath: metricsPath,
      statusPath,
      timeoutMs,
    })
    if (
      controlled.exit.status !== 'exit-0'
      || !controlled.exit.processExited
      || controlled.fileLimits.outputLimitExceeded
      || controlled.fileLimits.statusLimitExceeded
    ) throw new Error('structure_probe_failed')
    const [raw, rawStatus] = await Promise.all([
      readFile(metricsPath, 'utf8'),
      readFile(statusPath, 'utf8'),
    ])
    const parsedStatus = JSON.parse(rawStatus) as unknown
    if (
      typeof parsedStatus !== 'object'
      || parsedStatus === null
      || Array.isArray(parsedStatus)
      || Object.keys(parsedStatus).sort().join(',') !== 'chars,ok'
      || (parsedStatus as { ok?: unknown }).ok !== true
      || (parsedStatus as { chars?: unknown }).chars !== [...raw].length
    ) throw new Error('structure_probe_failed')
    return copyExactStructureMetrics(JSON.parse(raw) as unknown, sample)
  }
}

function epubStructure(output: string): ProbeStructureMetrics {
  const preservedHeadings = [
    /^#\s+First Chapter\s*$/mu,
    /^##\s+Second Chapter\s*$/mu,
  ].filter((pattern) => pattern.test(output)).length
  const preservedListItems = [
    /^\s*[-*+]\s+First item\s*$/mu,
    /^\s*[-*+]\s+Second item\s*$/mu,
  ].filter((pattern) => pattern.test(output)).length
  const preservedEmphasis = /(?:\*|_)emphasis(?:\*|_)/u.test(output) ? 1 : 0
  const preservedLinks = /\[the example link\]\(https:\/\/example\.com\/?\)/u.test(output) ? 1 : 0
  return {
    kind: 'chapters',
    sourceUnits: 2,
    coveredUnits: preservedHeadings,
    missingUnits: 2 - preservedHeadings,
    noTextUnits: 0,
    blankUnits: 0,
    unverifiableUnits: 0,
    sourceRows: 0,
    coveredRows: 0,
    sourceCells: 0,
    coveredCells: 0,
    sourceTextChars: 58,
    matchedTextChars: (preservedHeadings * 10)
      + (preservedListItems * 10)
      + (preservedEmphasis * 8)
      + (preservedLinks * 10),
    expectedHeadings: 2,
    preservedHeadings,
    expectedListItems: 2,
    preservedListItems,
    expectedEmphasis: 1,
    preservedEmphasis,
    expectedLinks: 1,
    preservedLinks,
  }
}

async function hashFile(filePath: string): Promise<string> {
  return hashBytes(await readFile(filePath))
}

async function directoryDigest(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  const identities = entries
    .map((entry) => `${entry.name.normalize('NFC')}\0${entry.isFile() ? 'f' : entry.isDirectory() ? 'd' : 'o'}`)
    .sort()
  return hashBytes(identities.join('\n'))
}

async function snapshotSource(sourcePath: string): Promise<SourceSnapshot> {
  const metadata = await stat(sourcePath, { bigint: true })
  return {
    bytes: Number(metadata.size),
    sha256: await hashFile(sourcePath),
    mtimeNs: metadata.mtimeNs,
    directoryDigest: await directoryDigest(path.dirname(sourcePath)),
  }
}

function validateOptions(options: ProbeOptions): void {
  if (
    !options.component
    || !Array.isArray(options.samples)
    || options.samples.length === 0
    || !/^[a-f0-9]{64}$/.test(options.component.archiveSha256)
  ) throw new Error('invalid_probe_configuration')
  const ids = new Set<string>()
  for (const sample of options.samples) {
    if (
      !SUPPORTED_PROBE_FORMATS.includes(sample.format)
      || !ANONYMOUS_ID.test(sample.id)
      || ids.has(sample.id)
      || path.extname(sample.sourcePath).toLowerCase() !== `.${sample.format}`
      || !Number.isSafeInteger(sample.expectedUnits)
      || sample.expectedUnits < 0
    ) throw new Error('invalid_probe_configuration')
    ids.add(sample.id)
  }
}

function outputMetrics(text: string): Pick<
  ProbeSampleReport,
  'outputBytes' | 'outputChars' | 'outputSha256' | 'textCharacters' | 'headings' | 'tableRows' | 'replacementCharacters'
> {
  let outputChars = 0
  let textCharacters = 0
  let replacementCharacters = 0
  for (const character of text) {
    outputChars += 1
    if (/[\p{L}\p{N}]/u.test(character)) textCharacters += 1
    if (character === '\uFFFD') replacementCharacters += 1
  }
  let headings = 0
  let tableRows = 0
  for (const line of text.split(/\r?\n/u)) {
    if (/^#{1,6}\s+\S/u.test(line)) headings += 1
    if (/^\s*\|.*\|\s*$/u.test(line) && !/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/u.test(line)) tableRows += 1
  }
  return {
    outputBytes: Buffer.byteLength(text),
    outputChars,
    outputSha256: hashBytes(text),
    textCharacters,
    headings,
    tableRows,
    replacementCharacters,
  }
}

function executionResult(sample: ProbeSampleReport): ProbeResult {
  if (
    sample.exitStatus !== 'exit-0'
    || !sample.statusValid
    || sample.timedOut
    || !sample.outputWithinLimit
    || sample.outputLimitExceeded
    || sample.statusLimitExceeded
    || sample.outputBytes === 0
    || sample.outputChars === 0
    || sample.textCharacters === 0
    || sample.replacementCharacters > 0
    || !sample.sourceHashUnchanged
    || !sample.sourceSizeUnchanged
    || !sample.sourceMtimeUnchanged
    || !sample.processExited
    || !sample.cleanupComplete
  ) return 'fail'
  return 'pass'
}

function fidelityResult(sample: ProbeSampleReport): ProbeResult {
  if (sample.executionResult === 'fail') return 'fail'
  if (!sample.structureValid) return 'conditional'
  if (sample.structure.sourceUnits <= 0) return 'fail'
  const structure = sample.structure
  if (
    (structure.sourceTextChars > 0 && structure.matchedTextChars === 0)
    || (structure.sourceRows > 0 && structure.coveredRows === 0)
    || (structure.sourceCells > 0 && structure.coveredCells === 0)
  ) return 'fail'
  if (
    structure.missingUnits > 0
    || structure.unverifiableUnits > 0
    || structure.matchedTextChars < structure.sourceTextChars
    || structure.coveredRows < structure.sourceRows
    || structure.coveredCells < structure.sourceCells
    || structure.preservedHeadings < structure.expectedHeadings
    || structure.preservedListItems < structure.expectedListItems
    || structure.preservedEmphasis < structure.expectedEmphasis
    || structure.preservedLinks < structure.expectedLinks
  ) return 'conditional'
  return 'pass'
}

function refreshSampleResults(sample: ProbeSampleReport): void {
  sample.executionResult = executionResult(sample)
  sample.fidelityResult = fidelityResult(sample)
  sample.result = aggregateResult([sample.executionResult, sample.fidelityResult])
}

async function probeSample(options: ProbeOptions, sample: ProbeSampleInput): Promise<ProbeSampleReport> {
  const limits = options.limits ?? DEFAULT_LIMITS
  const metadata = await lstat(sample.sourcePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limits.inputBytes) {
    throw new Error('invalid_probe_input')
  }
  const before = await snapshotSource(sample.sourcePath)
  const operationParent = options.operationParent ?? tmpdir()
  await mkdir(operationParent, { recursive: true })
  const operationDirectory = await mkdtemp(path.join(operationParent, 'arkdown-markitdown-probe-'))
  const inputPath = path.join(operationDirectory, `input.${sample.format}`)
  const outputPath = path.join(operationDirectory, 'output.md')
  const statusPath = path.join(operationDirectory, 'status.json')
  const timeoutMs = options.timeoutForFormat?.(sample.format) ?? FORMAT_TIMEOUTS[sample.format]
  const started = performance.now()
  let report: ProbeSampleReport | undefined
  try {
    options.onTimeoutSelected?.(timeoutMs, sample.format)
    await copyFile(sample.sourcePath, inputPath)
    const args = [
      ...(options.component.prefixArgs ?? []),
      options.component.cliPath,
      '--input', inputPath,
      '--output', outputPath,
      '--status', statusPath,
    ]
    options.onArguments?.(args)
    const controlled = await runConversionProcess({
      args,
      command: options.component.command,
      cwd: operationDirectory,
      outputLimitBytes: limits.outputBytes,
      outputPath,
      signal: options.signal,
      statusPath,
      timeoutMs,
    })
    let metrics = {
      outputBytes: 0,
      outputChars: 0,
      outputSha256: null as string | null,
      textCharacters: 0,
      headings: 0,
      tableRows: 0,
      replacementCharacters: 0,
    }
    let outputWithinLimit = !controlled.fileLimits.outputLimitExceeded
    let statusValid = false
    let structure = emptyStructure(sample)
    let structureValid = false
    try {
      const outputMetadata = await stat(outputPath)
      outputWithinLimit &&= outputMetadata.size <= limits.outputBytes
      if (outputWithinLimit) {
        const output = await readFile(outputPath, 'utf8')
        metrics = outputMetrics(output)
        const statusMetadata = await stat(statusPath)
        if (statusMetadata.size <= STATUS_OUTPUT_LIMIT_BYTES && !controlled.fileLimits.statusLimitExceeded) {
          const parsed = JSON.parse(await readFile(statusPath, 'utf8')) as unknown
          statusValid = typeof parsed === 'object'
            && parsed !== null
            && !Array.isArray(parsed)
            && Object.keys(parsed).sort().join(',') === 'chars,ok'
            && (parsed as { ok?: unknown }).ok === true
            && (parsed as { chars?: unknown }).chars === metrics.outputChars
        }
      }
    } catch {
      outputWithinLimit = false
    }
    if (outputWithinLimit) {
      try {
        structure = copyExactStructureMetrics(
          await options.inspectStructure(
            { ...sample, sourcePath: inputPath },
            outputPath,
            Math.max(1, timeoutMs - Math.ceil(performance.now() - started)),
          ),
          sample,
        )
        structureValid = true
      } catch {
        structureValid = false
      }
    }
    const after = await snapshotSource(sample.sourcePath)
    report = {
      id: sample.id,
      format: sample.format,
      sourceBytes: before.bytes,
      ...metrics,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)),
      peakWorkingSetBytes: null,
      exitStatus: controlled.exit.status,
      statusValid,
      timedOut: controlled.exit.timedOut,
      outputWithinLimit,
      outputLimitExceeded: controlled.fileLimits.outputLimitExceeded,
      statusLimitExceeded: controlled.fileLimits.statusLimitExceeded,
      sourceHashUnchanged: before.sha256 === after.sha256,
      sourceSizeUnchanged: before.bytes === after.bytes,
      sourceMtimeUnchanged: before.mtimeNs === after.mtimeNs,
      sourceDirectoryUnchanged: before.directoryDigest === after.directoryDigest,
      processExited: controlled.exit.processExited,
      cleanupComplete: false,
      headings: metrics.headings,
      tableRows: metrics.tableRows,
      replacementCharacters: metrics.replacementCharacters,
      structureValid,
      structure,
      executionResult: 'fail',
      fidelityResult: 'fail',
      result: 'fail',
    }
    refreshSampleResults(report)
    return report
  } finally {
    let cleanupComplete = false
    try {
      const remove = options.removeOperationDirectory
        ?? (async (pathname: string) => await rm(pathname, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }))
      await remove(operationDirectory)
      try {
        await lstat(operationDirectory)
      } catch (error) {
        cleanupComplete = (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    } catch {
      cleanupComplete = false
    }
    if (report) {
      report.cleanupComplete = cleanupComplete
      refreshSampleResults(report)
    } else if (!cleanupComplete) {
      throw new Error('probe_cleanup_failed')
    }
  }
}

function aggregateResult(values: readonly ProbeResult[]): ProbeResult {
  if (values.some((value) => value === 'fail')) return 'fail'
  return values.some((value) => value === 'conditional') ? 'conditional' : 'pass'
}

export async function runMarkItDownProbe(options: ProbeOptions): Promise<ProbeReport> {
  try {
    validateOptions(options)
    const operationParent = options.operationParent ?? tmpdir()
    await mkdir(operationParent, { recursive: true })
    const baseline = new Map<string, SourceSnapshot>()
    for (const sample of options.samples) baseline.set(sample.sourcePath, await snapshotSource(sample.sourcePath))
    const samples: ProbeSampleReport[] = []
    for (const sample of options.samples) samples.push(await probeSample(options, sample))
    for (let index = 0; index < options.samples.length; index += 1) {
      const sample = options.samples[index]!
      const result = samples[index]!
      try {
        const after = await snapshotSource(sample.sourcePath)
        const before = baseline.get(sample.sourcePath)!
        result.sourceHashUnchanged &&= before.sha256 === after.sha256
        result.sourceSizeUnchanged &&= before.bytes === after.bytes
        result.sourceMtimeUnchanged &&= before.mtimeNs === after.mtimeNs
        result.sourceDirectoryUnchanged &&= before.directoryDigest === after.directoryDigest
      } catch {
        result.sourceHashUnchanged = false
        result.sourceSizeUnchanged = false
        result.sourceMtimeUnchanged = false
        result.sourceDirectoryUnchanged = false
      }
      refreshSampleResults(result)
    }
    const formats = SUPPORTED_PROBE_FORMATS
      .filter((format) => samples.some((sample) => sample.format === format))
      .map((format) => {
        const formatSamples = samples.filter((sample) => sample.format === format)
        const executionResult = aggregateResult(formatSamples.map((sample) => sample.executionResult))
        const fidelityResult = aggregateResult(formatSamples.map((sample) => sample.fidelityResult))
        return {
          format,
          executionResult,
          fidelityResult,
          result: aggregateResult([executionResult, fidelityResult]),
        }
      })
    const completeFormatSet = formats.length === SUPPORTED_PROBE_FORMATS.length
    const executionDecision = aggregateResult(formats.map((entry) => entry.executionResult))
    const fidelityDecision = aggregateResult(formats.map((entry) => entry.fidelityResult))
    return {
      schemaVersion: 1,
      componentVersion: options.component.version,
      archiveBytes: options.component.archiveBytes,
      archiveSha256: options.component.archiveSha256,
      samples,
      formats,
      executionDecision,
      fidelityDecision,
      decision: completeFormatSet ? aggregateResult([executionDecision, fidelityDecision]) : 'fail',
    }
  } catch (error) {
    if (
      error instanceof Error
      && ['invalid_probe_configuration', 'invalid_probe_input', 'probe_cleanup_failed'].includes(error.message)
    ) throw error
    throw new Error('probe_failed')
  }
}

export async function resolveAuthorizedSamples(
  sampleRoot: string,
  identities: readonly AuthorizedSampleIdentity[] = AUTHORIZED_SAMPLE_IDENTITIES,
): Promise<ProbeSampleInput[]> {
  try {
    const rootMetadata = await lstat(sampleRoot)
    const assetsRoot = path.join(sampleRoot, 'assets')
    const assetsMetadata = await lstat(assetsRoot)
    if (
      !rootMetadata.isDirectory()
      || rootMetadata.isSymbolicLink()
      || !assetsMetadata.isDirectory()
      || assetsMetadata.isSymbolicLink()
    ) throw new Error('authorized_sample_set_mismatch')
    const candidates: Array<{ relative: string; absolute: string }> = []
    for (const entry of await readdir(sampleRoot, { withFileTypes: true })) {
      if (entry.isFile()) candidates.push({ relative: entry.name, absolute: path.join(sampleRoot, entry.name) })
    }
    for (const entry of await readdir(assetsRoot, { withFileTypes: true })) {
      if (entry.isFile()) {
        candidates.push({ relative: `assets/${entry.name}`, absolute: path.join(assetsRoot, entry.name) })
      }
    }
    const byIdentity = new Map<string, string[]>()
    for (const candidate of candidates) {
      const identity = hashBytes(candidate.relative.normalize('NFC'))
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), candidate.absolute])
    }
    return await Promise.all(identities.map(async (identity) => {
      const matches = byIdentity.get(identity.relativeNameSha256) ?? []
      if (
        !ANONYMOUS_ID.test(identity.id)
        || !SUPPORTED_PROBE_FORMATS.includes(identity.format)
        || matches.length !== 1
        || path.extname(matches[0]!).toLowerCase() !== `.${identity.format}`
      ) throw new Error('authorized_sample_set_mismatch')
      const metadata = await lstat(matches[0]!)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('authorized_sample_set_mismatch')
      return { id: identity.id, format: identity.format, sourcePath: matches[0]!, expectedUnits: 0 }
    }))
  } catch {
    throw new Error('authorized_sample_set_mismatch')
  }
}

function structureSummary(structure: ProbeStructureMetrics): string {
  return [
    `${structure.kind}:${structure.coveredUnits}/${structure.sourceUnits}`,
    `missing=${structure.missingUnits}`,
    `no-text=${structure.noTextUnits}`,
    `blank=${structure.blankUnits}`,
    `unverifiable=${structure.unverifiableUnits}`,
    `rows=${structure.coveredRows}/${structure.sourceRows}`,
    `cells=${structure.coveredCells}/${structure.sourceCells}`,
    `text=${structure.matchedTextChars}/${structure.sourceTextChars}`,
    `headings=${structure.preservedHeadings}/${structure.expectedHeadings}`,
    `list=${structure.preservedListItems}/${structure.expectedListItems}`,
    `emphasis=${structure.preservedEmphasis}/${structure.expectedEmphasis}`,
    `links=${structure.preservedLinks}/${structure.expectedLinks}`,
  ].join('; ')
}

export function renderProbeMarkdown(report: ProbeReport): string {
  const lines = [
    '# MarkItDown document-conversion POC',
    '',
    `- Component version: ${report.componentVersion}`,
    `- Archive bytes: ${report.archiveBytes}`,
    `- Archive SHA-256: \`${report.archiveSha256}\``,
    '',
    '| Sample | Format | Source bytes | Output bytes | Output chars | Text chars | Output SHA-256 | Elapsed ms | Peak working set bytes | Exit | Timeout | Status valid | Output cap | Status cap | Headings | Table rows | U+FFFD | Structure valid | Structure | Source immutable | Source directory observation | Process exited | Operation cleanup | Execution | Fidelity | Result |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.samples.map((sample) => `| ${[
      sample.id,
      sample.format,
      sample.sourceBytes,
      sample.outputBytes,
      sample.outputChars,
      sample.textCharacters,
      sample.outputSha256 ?? 'n/a',
      sample.elapsedMs,
      sample.peakWorkingSetBytes ?? 'n/a',
      sample.exitStatus,
      sample.timedOut ? 'yes' : 'no',
      sample.statusValid ? 'yes' : 'no',
      sample.outputWithinLimit && !sample.outputLimitExceeded ? 'yes' : 'no',
      sample.statusLimitExceeded ? 'no' : 'yes',
      sample.headings,
      sample.tableRows,
      sample.replacementCharacters,
      sample.structureValid ? 'yes' : 'no',
      structureSummary(sample.structure),
      sample.sourceHashUnchanged && sample.sourceSizeUnchanged && sample.sourceMtimeUnchanged ? 'yes' : 'no',
      sample.sourceDirectoryUnchanged ? 'yes' : 'no',
      sample.processExited ? 'yes' : 'no',
      sample.cleanupComplete ? 'yes' : 'no',
      sample.executionResult,
      sample.fidelityResult,
      sample.result,
    ].join(' | ')} |`),
    '',
    '## Format decisions',
    '',
    ...report.formats.map((entry) => `- ${entry.format}: execution=${entry.executionResult}; fidelity=${entry.fidelityResult}; overall=${entry.result}`),
    '',
    `execution decision: ${report.executionDecision}`,
    `fidelity decision: ${report.fidelityDecision}`,
    `decision: ${report.decision}`,
    '',
    'Execution note: source-directory churn is a non-gating observation; source file hash, size, and mtime immutability are the gate.',
    'Fidelity note: unit coverage measures source content found in the combined Markdown; PDF page boundaries and duplicate slide identity are not asserted.',
  ]
  if (report.samples.some((sample) => !sample.structureValid)) {
    lines.push('Structure note: structure-valid=no is fidelity conditional/unverified and is never treated as fidelity pass.')
  }
  if (report.decision === 'fail') {
    const blocked = report.formats.filter((entry) => entry.result !== 'pass').map((entry) => entry.format).join(', ')
    lines.push(
      '',
      `Recommendation: repair and re-run ${blocked || 'the incomplete format set'} before product integration.`,
    )
  } else if (report.decision === 'conditional') {
    lines.push('', 'Recommendation: GO for preview-and-confirm workflows with the recorded fidelity warnings; preserve the original document and do not treat conversion as lossless.')
  }
  return `${lines.join('\n')}\n`
}

async function writeAtomicReport(destination: string, contents: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const pending = `${destination}.${process.pid}.pending`
  try {
    await writeFile(pending, contents, { encoding: 'utf8', flag: 'wx' })
    await rename(pending, destination)
  } finally {
    await rm(pending, { force: true })
  }
}

async function parsePublicManifest(manifestPath: string): Promise<{
  version: string
  archiveName: string
  bytes: number
  sha256: string
}> {
  const value = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('component_manifest_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'archiveName,bytes,sha256,version'
    || record.version !== APPROVED_COMPONENT.version
    || record.bytes !== APPROVED_COMPONENT.bytes
    || record.sha256 !== APPROVED_COMPONENT.sha256
    || typeof record.archiveName !== 'string'
    || path.basename(record.archiveName) !== record.archiveName
  ) throw new Error('component_manifest_invalid')
  return record as { version: string; archiveName: string; bytes: number; sha256: string }
}

async function realProbe(sampleRoot: string, repoRoot: string): Promise<ProbeReport> {
  const runRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-markitdown-real-poc-'))
  let report: ProbeReport | undefined
  try {
    const componentRoot = path.join(repoRoot, '.components', 'markitdown')
    const manifestPath = path.join(componentRoot, 'manifest.json')
    const manifest = await parsePublicManifest(manifestPath)
    const buildResult: ComponentBuildResult = {
      archivePath: path.join(componentRoot, manifest.archiveName),
      manifestPath,
      version: manifest.version as ComponentBuildResult['version'],
      bytes: manifest.bytes,
      sha256: manifest.sha256,
    }
    const runtimeRoot = path.join(runRoot, 'runtime')
    await inspectBuiltComponent(buildResult, {
      repoRoot,
      extractionRoot: runtimeRoot,
      smoke: async () => [
        { format: 'pdf', chars: 1 },
        { format: 'pptx', chars: 1 },
        { format: 'xlsx', chars: 1 },
        { format: 'epub', chars: 1 },
      ],
    })
    const python = path.join(runtimeRoot, 'python.exe')
    const structureProbePath = path.join(runtimeRoot, 'arkdown_structure_probe.py')
    await writeEmbeddedStructureProbe(structureProbePath)
    const fixturePath = path.join(runRoot, 'fixture.epub')
    await runMetadataProcess(
      python,
      ['-I', path.join(repoRoot, 'scripts', 'markitdown', 'create_epub_fixture.py'), fixturePath],
      runtimeRoot,
      120_000,
    )
    const samples = await resolveAuthorizedSamples(sampleRoot)
    samples.push({ id: 'epub-1', format: 'epub', sourcePath: fixturePath, expectedUnits: 2 })
    const inspector = createStructureInspector({
      command: python,
      prefixArgs: ['-I'],
      probeScript: structureProbePath,
    })
    report = await runMarkItDownProbe({
      component: {
        version: manifest.version,
        archiveBytes: manifest.bytes,
        archiveSha256: manifest.sha256,
        command: python,
        cliPath: path.join(runtimeRoot, 'arkdown_markitdown.py'),
        prefixArgs: ['-I'],
        runtimeRoot,
      },
      samples,
      operationParent: path.join(runRoot, 'operations'),
      inspectStructure: async (sample, outputPath, timeoutMs) => sample.format === 'epub'
        ? epubStructure(await readFile(outputPath, 'utf8'))
        : await inspector(sample, outputPath, timeoutMs),
    })
    return report
  } finally {
    let cleanupComplete = false
    try {
      await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      try {
        await lstat(runRoot)
      } catch (error) {
        cleanupComplete = (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
    } catch {
      cleanupComplete = false
    }
    if (!cleanupComplete && report) {
      for (const sample of report.samples) {
        sample.cleanupComplete = false
        refreshSampleResults(sample)
      }
      for (const format of report.formats) {
        format.executionResult = 'fail'
        format.fidelityResult = 'fail'
        format.result = 'fail'
      }
      report.executionDecision = 'fail'
      report.fidelityDecision = 'fail'
      report.decision = 'fail'
    } else if (!cleanupComplete) {
      throw new Error('probe_cleanup_failed')
    }
  }
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--sample-root' || !path.isAbsolute(argv[1]!)) {
    process.stderr.write('Usage: probe-markitdown-conversion --sample-root <absolute-path>\n')
    return 2
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const report = await realProbe(path.resolve(argv[1]!), repoRoot)
    await writeAtomicReport(
      path.join(repoRoot, 'docs', 'research', '2026-08-22-markitdown-poc.md'),
      renderProbeMarkdown(report),
    )
    process.stdout.write(`decision=${report.decision}\n`)
    return report.decision === 'pass' ? 0 : 1
  } catch {
    process.stderr.write('markitdown_probe_failed\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().then((code) => { process.exitCode = code })
}

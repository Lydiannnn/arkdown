import {
  connectionFieldRevision, hasSettingsKeys, isSettingsField, isSettingsRecord, isSettingsRevision,
  settingsValuesEqual,
} from './settings-transaction-schema'
import type {
  ConnectionRevisionField, SettingsConflictField, SettingsCredentialChange,
  SettingsTransactionConflict, SettingsTransactionReduction, SettingsTransactionSnapshot,
} from './settings-transaction-types'

type InvalidReduction = Extract<SettingsTransactionReduction, { status: 'invalid' }>

export class SettingsReductionAbort extends Error {
  constructor(readonly result: SettingsTransactionConflict | InvalidReduction) {
    super('Settings transaction was not prepared')
  }
}

/** Private working copy. Functions passed to it are main-owned reducer code, never request data. */
export class SettingsTransactionDraft {
  readonly next: SettingsTransactionSnapshot
  readonly changedFields = new Set<string>()
  readonly changedConnections = new Map<string, Set<ConnectionRevisionField>>()
  readonly removedConnections = new Set<string>()
  readonly connectionOperations = new Set<string>()
  credentialChange: SettingsCredentialChange | undefined
  operationIndex = 0
  private readonly writes = new Set<string>()

  constructor(readonly latest: SettingsTransactionSnapshot, readonly baseRevision: number) {
    this.next = structuredClone(latest)
  }

  invalid(reason: InvalidReduction['reason'] = 'invalid-request'): never {
    throw new SettingsReductionAbort({ status: 'invalid', reason, operationIndex: this.operationIndex })
  }

  conflict(fields: SettingsConflictField[], reason: SettingsTransactionConflict['reason'] = 'field-changed'): never {
    throw new SettingsReductionAbort({ status: 'conflict', reason, fields,
      operationIndex: this.operationIndex, snapshot: structuredClone(this.latest) })
  }

  checkExpected(expected: unknown, value: unknown, revision: number, field: SettingsConflictField): void {
    if (!hasSettingsKeys(expected, ['value', 'revision']) || !isSettingsRevision(expected.revision)
      || expected.revision > this.baseRevision) this.invalid()
    if (expected.revision !== revision || !settingsValuesEqual(expected.value, value)) this.conflict([field])
  }

  checkField(field: string, expected: unknown, value: unknown): void {
    if (!isSettingsField(field)) this.invalid()
    this.checkExpected(expected, value, this.latest.fieldRevisions.fields[field] ?? 0, { kind: 'field', field })
  }

  checkConnectionField(id: string, field: ConnectionRevisionField, expected: unknown, value: unknown): void {
    this.checkExpected(expected, value, connectionFieldRevision(this.latest.fieldRevisions, id, field), { kind: 'connection', id, field })
  }

  checkCredential(id: string, expected: unknown): void {
    if (!isSettingsRevision(expected) || expected > this.baseRevision) this.invalid()
    if (expected !== connectionFieldRevision(this.latest.fieldRevisions, id, 'credential')) {
      this.conflict([{ kind: 'connection', id, field: 'credential' }])
    }
  }

  claim(token: string): void {
    if (this.writes.has(token)) this.invalid('duplicate-write')
    this.writes.add(token)
  }

  writeField(field: string, before: unknown, after: unknown, apply: () => void): void {
    if (!isSettingsField(field)) this.invalid()
    this.claim(`field:${field}`)
    if (settingsValuesEqual(before, after)) return
    apply()
    this.changedFields.add(field)
  }

  touchConnection(id: string, field: ConnectionRevisionField): void {
    const fields = this.changedConnections.get(id) ?? new Set<ConnectionRevisionField>()
    fields.add(field)
    fields.add('entity')
    this.changedConnections.set(id, fields)
  }

  beginConnectionOperation(id: string): void {
    if (this.connectionOperations.has(id)) this.invalid('duplicate-write')
    this.connectionOperations.add(id)
  }

  changeCredential(change: SettingsCredentialChange): void {
    if (this.credentialChange) this.invalid('credential-change-limit')
    this.credentialChange = change
    this.touchConnection(change.id, 'credential')
  }

  /** Undefined entries/values do not mean deletion. Deletion has separate explicit operations. */
  patch(changes: unknown, allowed: readonly string[], current: Record<string, unknown>,
    check: (field: string, expected: unknown) => void,
    write: (field: string, before: unknown, after: unknown, apply: () => void) => void,
  ): Record<string, unknown> {
    if (!isSettingsRecord(changes) || Object.keys(changes).some(field => !allowed.includes(field))) this.invalid()
    const next = structuredClone(current)
    for (const [field, change] of Object.entries(changes)) {
      if (change === undefined) continue
      if (!hasSettingsKeys(change, ['value', 'expected'])) this.invalid()
      if (change.value === undefined) continue
      check(field, change.expected)
      let copied: unknown
      try { copied = structuredClone(change.value) } catch { this.invalid('invalid-value') }
      write(field, current[field], copied, () => { next[field] = copied })
    }
    return next
  }
}

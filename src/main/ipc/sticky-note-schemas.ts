import path from 'node:path'
import { z } from 'zod'
import {
  isCanonicalStickyNoteId,
  STICKY_NOTE_MARKDOWN_MAX_BYTES,
  STICKY_NOTE_SEARCH_QUERY_MAX_LENGTH,
} from '../../shared/sticky-notes'

export const stickyNoteIdSchema = z.string().refine(isCanonicalStickyNoteId)
export const stickyNoteStatusValueSchema = z.enum(['active', 'archived'])
export const stickyNoteLineSpacingModeSchema = z.enum(['compact', 'standard'])
export const stickyNoteQuerySchema = z.string()
  .trim()
  .min(1)
  .max(STICKY_NOTE_SEARCH_QUERY_MAX_LENGTH)
export const stickyNoteForegroundSourceIdSchema = z.string()
  .max(128)
  .regex(/^window:[0-9]+:[0-9]+$/u)
export const stickyNoteMarkdownSchema = z.string().refine((value) => (
  Buffer.byteLength(value, 'utf8') <= STICKY_NOTE_MARKDOWN_MAX_BYTES
))
export const stickyNoteReferenceSchema = z.object({ noteId: stickyNoteIdSchema }).strict()
export const archivedStickyNoteBatchSchema = z.object({
  noteIds: z.array(stickyNoteIdSchema).min(1).max(100_000),
}).strict()
export const restoreArchivedStickyNotesSchema = archivedStickyNoteBatchSchema
export const deleteArchivedStickyNotesSchema = archivedStickyNoteBatchSchema
export const setStickyNoteLineSpacingModeSchema = z.object({
  noteId: stickyNoteIdSchema,
  lineSpacingMode: stickyNoteLineSpacingModeSchema,
}).strict()
export const stickyNoteStatusSchema = z.object({ status: stickyNoteStatusValueSchema }).strict()
export const stickyNoteSearchSchema = z.object({
  status: stickyNoteStatusValueSchema,
  query: stickyNoteQuerySchema,
}).strict()
export const openStickyNoteSchema = z.object({
  noteId: stickyNoteIdSchema,
  query: stickyNoteQuerySchema.optional(),
}).strict()
export const importStickyNoteSchema = z.object({
  absolutePath: z.string().max(32_767).refine((value) => path.isAbsolute(value)),
}).strict()
export const stickyNoteSelectionResourceSchema = z.object({
  originalReference: z.string().min(1).max(32_767),
  absolutePath: z.string().max(32_767).refine((value) => path.isAbsolute(value)),
}).strict()
export const importStickyNoteSelectionSchema = z.object({
  markdown: stickyNoteMarkdownSchema,
  localResources: z.array(stickyNoteSelectionResourceSchema).max(512),
}).strict()

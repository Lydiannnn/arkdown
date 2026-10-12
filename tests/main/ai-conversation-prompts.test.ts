import { describe, expect, it } from 'vitest'
import {
  AI_CONVERSATION_SYSTEM_PROMPT,
  AI_WORKSPACE_TOOLS,
  buildAiConversationMessages,
} from '../../src/main/models/ai-conversation-prompts'
import { parseWorkspaceToolArguments } from '../../src/shared/ai-conversation'

describe('AI workspace prompt registry', () => {
  it('registers every workspace tool using relative-path schemas only', () => {
    expect(AI_WORKSPACE_TOOLS.map((tool) => tool.name)).toEqual([
      'read_current_document',
      'list_workspace_entries',
      'read_workspace_document',
      'edit_workspace_document',
      'create_workspace_document',
      'rename_workspace_document',
      'delete_workspace_document',
    ])
    for (const tool of AI_WORKSPACE_TOOLS) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain('absolutePath')
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('shares the strict relative-path policy with every path-bearing tool schema', () => {
    const schemas = AI_WORKSPACE_TOOLS.flatMap((tool) => {
      const input = tool.inputSchema as {
        properties?: Record<string, { pattern?: string; anyOf?: Array<{ pattern?: string }> }>
        oneOf?: Array<{ properties: Record<string, { pattern?: string; anyOf?: Array<{ pattern?: string }> }> }>
      }
      const branches = input.oneOf ?? [{ properties: input.properties ?? {} }]
      return branches.flatMap(({ properties }) => [properties.path, properties.newPath]
        .filter(Boolean)
        .flatMap((schema) => schema.anyOf?.filter((candidate) => candidate.pattern !== undefined) ?? [schema]))
    })
    for (const schema of schemas) {
      expect(schema.pattern).toContain('\\u0000')
      expect(schema.pattern).toContain('\\\\')
      const pattern = new RegExp(schema.pattern!)
      expect(pattern.test('notes/todo.md')).toBe(true)
      for (const path of ['NUL.txt', 'nul.txt', 'CoN.md', 'notes/file. ', 'notes/', 'notes//todo.md', 'notes/\0todo.md', 'C:\\private\\todo.md', ' notes/todo.md', 'notes/todo.md ', 'a'.repeat(256)]) {
        expect(pattern.test(path)).toBe(false)
      }
    }
  })

  it('reuses opaque identifier schema for expected file versions', () => {
    const edit = AI_WORKSPACE_TOOLS.find((tool) => tool.name === 'edit_workspace_document')!
    const expectedVersion = (edit.inputSchema.properties as Record<string, { properties?: Record<string, { pattern?: string }> }>).expectedVersion
    expect(expectedVersion.properties?.fileId?.pattern).toContain('A-Za-z0-9')
    expect(expectedVersion.properties?.revision?.pattern).toContain('A-Za-z0-9')
  })

  it('uses one provider-compatible list object while enforcing pagination coupling locally', () => {
    const list = AI_WORKSPACE_TOOLS.find((tool) => tool.name === 'list_workspace_entries')!
    expect(list.inputSchema).toMatchObject({ type: 'object', required: ['path', 'maxEntries', 'cursor', 'directoryVersion'] })
    expect(list.inputSchema).not.toHaveProperty('oneOf')
    const version = { workspaceGeneration: 'workspace-1', directoryId: 'directory-1', revision: 'revision-1' }
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', maxEntries: 10 })).toEqual({
      toolName: 'list_workspace_entries', arguments: { path: '', cursor: 0, maxEntries: 10, directoryVersion: null },
    })
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 10, maxEntries: 10 })).toBeUndefined()
    // A real DeepSeek response supplied cursor 0 without its paired version.
    // Require the complete pagination pair on the provider wire instead of
    // weakening local version checks to accept this incomplete shape.
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 0, maxEntries: 10 })).toBeUndefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', maxEntries: 10, directoryVersion: version })).toBeUndefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', maxEntries: 10, extra: true })).toBeUndefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 0, maxEntries: 10, directoryVersion: null })).toBeDefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 10, maxEntries: 10, directoryVersion: version })).toBeDefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 10, maxEntries: 10, directoryVersion: null })).toBeUndefined()
    expect(parseWorkspaceToolArguments('list_workspace_entries', { path: '', cursor: 0, maxEntries: 10, directoryVersion: version })).toBeUndefined()
  })

  it('does not put local authorization state or audit paths on the provider wire', () => {
    const messages = buildAiConversationMessages({
      messages: [{ role: 'user', content: 'Summarize notes/todo.md' }],
    })

    expect(messages).toEqual([
      { role: 'system', content: AI_CONVERSATION_SYSTEM_PROMPT },
      { role: 'user', content: 'Summarize notes/todo.md' },
    ])
    expect(AI_CONVERSATION_SYSTEM_PROMPT).toContain('确认的工作区相对路径')
    expect(AI_CONVERSATION_SYSTEM_PROMPT).not.toContain('C:\\')
  })
})

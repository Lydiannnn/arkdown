import { Crepe } from '@milkdown/crepe'
import { defaultValueCtx, Editor, editorViewCtx, serializerCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { frontmatterEditorPlugins } from '../../src/renderer/editor/frontmatter-code-block'
import { buildStructuredBlockInsertionTransaction } from '../../src/renderer/editor/structured-block-insertion'

const editors: Editor[] = []

class IntersectionObserverStub {
  root = null
  rootMargin = '0px'
  thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

beforeAll(() => {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

afterEach(async () => {
  await Promise.all(editors.splice(0).map((editor) => editor.destroy()))
  document.body.replaceChildren()
})

async function createEditor(markdown: string) {
  const editor = Editor.make()
  editor.use(commonmark)
  for (const plugin of frontmatterEditorPlugins) editor.use(plugin)
  editor.config((ctx) => {
    ctx.set(defaultValueCtx, markdown)
  })
  await editor.create()
  editors.push(editor)
  return editor
}

async function createCrepeEditor(markdown: string) {
  const root = document.createElement('div')
  document.body.append(root)
  const crepe = new Crepe({
    root,
    defaultValue: markdown,
    features: {
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.BlockEdit]: false,
      [Crepe.Feature.Cursor]: false,
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.LinkTooltip]: false,
      [Crepe.Feature.ListItem]: false,
      [Crepe.Feature.Placeholder]: false,
      [Crepe.Feature.Table]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Latex]: true,
    },
  })
  for (const plugin of frontmatterEditorPlugins) crepe.editor.use(plugin)
  await crepe.create()
  editors.push(crepe.editor)
  return crepe
}

describe('YAML Front Matter visual schema', () => {
  it('parses leading Front Matter as a marked code block and serializes it unchanged', async () => {
    const markdown = [
      '---',
      'title: Arkdown',
      'tags:',
      '  - editor',
      '---',
      '',
      '# Body',
    ].join('\n')
    const editor = await createEditor(markdown)
    const view = editor.ctx.get(editorViewCtx)
    const serializer = editor.ctx.get(serializerCtx)
    const frontmatter = view.state.doc.firstChild

    expect(frontmatter?.type.name).toBe('code_block')
    expect(frontmatter?.attrs).toMatchObject({
      language: 'YAML',
      frontmatter: true,
    })
    expect(view.dom.querySelector('[data-arkdown-frontmatter="true"]')).not.toBeNull()
    expect(frontmatter?.textContent).toContain('title: Arkdown')
    expect(serializer(view.state.doc).trimEnd()).toBe(markdown)
  })

  it('preserves Crepe LaTeX serialization while handling Front Matter and fenced code', async () => {
    const fence = '\x60\x60\x60'
    const markdown = [
      '---',
      'title: Arkdown',
      '---',
      '',
      `${fence}ts`,
      'const answer = 42',
      fence,
      '',
      '$$',
      'E = mc^2',
      '$$',
    ].join('\n')
    const crepe = await createCrepeEditor(markdown)

    expect(crepe.getMarkdown().trimEnd()).toBe(markdown)
  })

  it('round-trips an empty Front Matter block inserted into an empty document', async () => {
    const editor = await createEditor('')
    const view = editor.ctx.get(editorViewCtx)
    const serializer = editor.ctx.get(serializerCtx)
    const transaction = buildStructuredBlockInsertionTransaction(view.state, {
      language: 'YAML',
      frontmatter: true,
    })

    expect(transaction).not.toBeNull()
    view.dispatch(transaction!)
    expect(view.state.doc.firstChild?.attrs).toMatchObject({ language: 'YAML', frontmatter: true })
    expect(serializer(view.state.doc).trimEnd()).toBe('---\n---')
  })

  it('saves Front Matter moved behind body content as fenced YAML and reparses it safely', async () => {
    const editor = await createEditor('---\ntitle: Arkdown\n---\n\n# Body')
    const view = editor.ctx.get(editorViewCtx)
    const serializer = editor.ctx.get(serializerCtx)
    const paragraph = view.state.schema.nodes.paragraph.create(
      undefined,
      view.state.schema.text('Introduction'),
    )

    view.dispatch(view.state.tr.insert(0, paragraph))
    const saved = serializer(view.state.doc).trimEnd()
    expect(saved).toBe([
      'Introduction',
      '',
      '```YAML',
      'title: Arkdown',
      '```',
      '',
      '# Body',
    ].join('\n'))

    const reopened = await createEditor(saved)
    const reopenedView = reopened.ctx.get(editorViewCtx)
    expect(reopenedView.state.doc.child(1).attrs).toMatchObject({
      language: 'YAML',
      frontmatter: false,
    })
    reopenedView.state.doc.descendants((node) => {
      expect(node.attrs.frontmatter).not.toBe(true)
    })
  })

  it('does not confuse body horizontal rules with Front Matter', async () => {
    const editor = await createEditor('alpha\n\n---\n\nbeta')
    const view = editor.ctx.get(editorViewCtx)
    const nodes: Array<{ name: string; frontmatter?: boolean }> = []
    view.state.doc.descendants((node) => {
      nodes.push({
        name: node.type.name,
        frontmatter: node.attrs.frontmatter as boolean | undefined,
      })
    })

    expect(nodes.some((node) => node.name === 'hr')).toBe(true)
    expect(nodes.some((node) => node.frontmatter === true)).toBe(false)
  })

  it('keeps ordinary fenced YAML as fenced code', async () => {
    const fence = '\x60\x60\x60'
    const markdown = [fence + 'yaml', 'title: ordinary', fence].join('\n')
    const editor = await createEditor(markdown)
    const view = editor.ctx.get(editorViewCtx)
    const serializer = editor.ctx.get(serializerCtx)

    expect(view.state.doc.firstChild?.attrs).toMatchObject({
      language: 'yaml',
      frontmatter: false,
    })
    expect(serializer(view.state.doc).trimEnd()).toBe(markdown)
  })

  it('does not swallow an unclosed leading fence', async () => {
    const editor = await createEditor('---\ntitle: incomplete\n\n# Body')
    const view = editor.ctx.get(editorViewCtx)

    expect(view.state.doc.firstChild?.attrs.frontmatter).not.toBe(true)
    expect(view.state.doc.textContent).toContain('title: incomplete')
    expect(view.state.doc.textContent).toContain('Body')
  })
})

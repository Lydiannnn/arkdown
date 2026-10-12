import { codeBlockSchema } from '@milkdown/kit/preset/commonmark'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose, $remark } from '@milkdown/kit/utils'
import remarkFrontmatter from 'remark-frontmatter'

function yamlFrontmatter(this: ThisParameterType<typeof remarkFrontmatter>) {
  return remarkFrontmatter.call(this, 'yaml')
}

export const remarkFrontmatterPlugin = $remark(
  'arkdownFrontmatter',
  () => yamlFrontmatter,
)

export const frontmatterCodeBlockSchema = codeBlockSchema.extendSchema(
  (previous) => (context) => {
    const base = previous(context)
    return {
      ...base,
      attrs: {
        ...base.attrs,
        frontmatter: {
          default: false,
          validate: 'boolean',
        },
      },
      parseMarkdown: {
        match: (node) => node.type === 'code' || node.type === 'yaml',
        runner: (state, node, type) => {
          if (node.type !== 'yaml') {
            base.parseMarkdown!.runner(state, node, type)
            return
          }
          state.openNode(type, {
            language: 'YAML',
            frontmatter: true,
          })
          if (typeof node.value === 'string' && node.value) state.addText(node.value)
          state.closeNode()
        },
      },
      toMarkdown: {
        match: (node) => node.type.name === 'code_block',
        runner: (state, node) => {
          if (node.attrs.frontmatter === true) {
            const parent = state.top()
            const isDocumentLeadingNode = parent?.type === 'root'
              && (parent.children?.length ?? 0) === 0
            state.addNode(
              isDocumentLeadingNode ? 'yaml' : 'code',
              undefined,
              node.textContent,
              isDocumentLeadingNode ? undefined : { lang: 'YAML' },
            )
            return
          }
          const language = typeof node.attrs.language === 'string'
            ? node.attrs.language
            : ''
          if (language.toLowerCase() === 'latex') {
            state.addNode('math', undefined, node.content.firstChild?.text ?? '')
            return
          }
          base.toMarkdown!.runner(state, node)
        },
      },
    }
  },
)

function frontmatterDecorations(doc: Parameters<typeof DecorationSet.create>[0]): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.name === 'code_block' && node.attrs.frontmatter === true) {
      decorations.push(Decoration.node(position, position + node.nodeSize, {
        'data-arkdown-frontmatter': 'true',
        'aria-label': 'YAML Front Matter',
      }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

const frontmatterDecorationKey = new PluginKey<DecorationSet>('arkdownFrontmatterDecorations')

export const frontmatterDecorationsPlugin = $prose(() => new Plugin<DecorationSet>({
  key: frontmatterDecorationKey,
  state: {
    init: (_, state) => frontmatterDecorations(state.doc),
    apply: (transaction, previous) => (
      transaction.docChanged ? frontmatterDecorations(transaction.doc) : previous
    ),
  },
  props: {
    decorations: (state) => frontmatterDecorationKey.getState(state) ?? null,
  },
}))

export const frontmatterEditorPlugins = [
  remarkFrontmatterPlugin,
  frontmatterCodeBlockSchema,
  frontmatterDecorationsPlugin,
] as const

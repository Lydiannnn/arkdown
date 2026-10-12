import { createElement, memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Root, RootContent } from 'mdast'
import type { DocumentViewSnapshot } from '../../shared/document-view'
import { parseDocumentViewLink, parseLocalFileLink } from '../../shared/document-view-link'
import { documentHeadingAnchor } from '../../shared/document-heading-anchor'
import { parseLinkTarget } from '../../shared/link-target'
import { externalAssetUrl } from '../../shared/local-resource-path'
import { resolveRelativeMarkdownImageSource } from '../editor/local-media-view'

function imageSource(source: string, absolutePath: string): string | undefined {
  const local = resolveRelativeMarkdownImageSource(source, absolutePath)
  if (local) return externalAssetUrl(local)
  const web = parseLinkTarget(source)
  return web?.kind === 'web' ? web.url : undefined
}

function plainText(node: { value?: string; children?: unknown[] }): string {
  return node.value ?? node.children?.map((child) => plainText(child as Parameters<typeof plainText>[0])).join('') ?? ''
}

function preserveLocalLinkPaths() {
  return (tree: Root) => {
    const definitions = new Map<string, string>()
    const walk = (node: Root | RootContent, visit: (node: Root | RootContent) => void) => {
      visit(node)
      if ('children' in node) for (const child of node.children) walk(child, visit)
    }
    walk(tree, (node) => {
      if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    })
    walk(tree, (node) => {
      const href = node.type === 'link' ? node.url
        : node.type === 'linkReference' ? definitions.get(node.identifier) : undefined
      if (!href || !parseLocalFileLink(href)) return
      // mdast-to-hast URI-encodes native paths. Retain the original destination
      // rather than decoding later: a literal "%20" is a valid filename too.
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, href } }
    })
  }
}

export const DocumentViewMarkdown = memo(function DocumentViewMarkdown({ document }: {
  document: DocumentViewSnapshot
}) {
  const slugs = new Map<string, number>()
  const assignedSlugs = new WeakMap<object, string>()
  const headings: Components = {}
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    headings[tag] = ({ node, children }) => {
      const assigned = node ? assignedSlugs.get(node) : undefined
      if (assigned !== undefined) return createElement(tag, { 'data-document-view-anchor': assigned }, children)
      const base = documentHeadingAnchor(plainText(node ?? {}))
      const count = slugs.get(base) ?? 0
      slugs.set(base, count + 1)
      const slug = count ? `${base}-${count}` : base
      if (node) assignedSlugs.set(node, slug)
      return createElement(tag, { 'data-document-view-anchor': slug }, children)
    }
  }
  return <div className="document-view-markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, preserveLocalLinkPaths]}
      skipHtml
      urlTransform={(url, key) => key === 'src'
        ? imageSource(url, document.absolutePath)
        : parseLinkTarget(url) || parseDocumentViewLink(url) ? url : undefined}
      components={{
        ...headings,
        a: ({ href, title, children }) => <a href={href} className={href && parseDocumentViewLink(href) ? 'document-view-relative-link' : undefined} data-tooltip={title || (href ? `Ctrl＋单击${parseDocumentViewLink(href)?.kind === 'relative' ? '在新窗口打开' : '打开'}\n${href}` : undefined)}>{children}</a>,
        img: ({ src, alt, title }) => <img src={src} alt={alt} data-tooltip={title} loading="lazy" />,
        input: ({ checked, type }) => <input checked={checked ?? false} type={type} disabled readOnly />,
      }}
    >{document.text}</ReactMarkdown>
  </div>
})

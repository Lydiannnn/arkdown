import type { HTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './safe-readonly-markdown.css'

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u
const ALLOWED_SCHEME_PATTERN = /^(?:https?|mailto):/iu
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu

export function sanitizeReadonlyMarkdownUrl(value: string): string | undefined {
  if (CONTROL_CHARACTER_PATTERN.test(value)) return undefined
  const url = value.trim()
  if (
    !url
    || url.startsWith('//')
    || url.startsWith('\\')
    || /^\/(?:\\|%5c)/iu.test(url)
  ) return undefined
  if (url.startsWith('#') || ALLOWED_SCHEME_PATTERN.test(url)) return url
  if (EXPLICIT_SCHEME_PATTERN.test(url)) return undefined
  return url
}

interface SafeReadonlyMarkdownProps extends HTMLAttributes<HTMLDivElement> {
  allowImages?: boolean
  allowMarks?: boolean
  markdown: string
}

const SAFE_MARK_TARGET = '#arkdown-safe-readonly-mark'

function markdownWithSafeMarks(markdown: string): string {
  return markdown.replace(/<mark>([^<>\r\n]+)<\/mark>/giu, (_match, text: string) => (
    `[${text.replace(/([\\[\]])/gu, '\\$1')}](${SAFE_MARK_TARGET})`
  ))
}

export function SafeReadonlyMarkdown({
  allowImages = true,
  allowMarks = false,
  className,
  markdown,
  ...props
}: SafeReadonlyMarkdownProps) {
  const classes = ['safe-readonly-markdown', className].filter(Boolean).join(' ')
  return (
    <div {...props} className={classes}>
      <ReactMarkdown
        components={{
          a: ({ href, title, node: _node, ...linkProps }) => allowMarks && href === SAFE_MARK_TARGET
            ? <mark>{linkProps.children}</mark>
            : <a {...linkProps} data-tooltip={title} href={href ? sanitizeReadonlyMarkdownUrl(href) : undefined} />,
          img: ({ src, title, node: _node, ...imageProps }) => (
            <img
              {...imageProps}
              data-tooltip={title}
              src={allowImages && typeof src === 'string'
                ? sanitizeReadonlyMarkdownUrl(src)
                : undefined}
            />
          ),
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => sanitizeReadonlyMarkdownUrl(url)}
      >
        {allowMarks ? markdownWithSafeMarks(markdown) : markdown}
      </ReactMarkdown>
    </div>
  )
}

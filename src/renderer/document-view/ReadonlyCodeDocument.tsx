import { useLayoutEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { DocumentViewSnapshot } from '../../shared/document-view'
import { loadCodeDocumentLanguage } from '../editor/code-document-language'

const previewHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, class: 'document-view-token-keyword' },
  { tag: [tags.string, tags.regexp], class: 'document-view-token-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'document-view-token-number' },
  { tag: tags.comment, class: 'document-view-token-comment' },
  { tag: [tags.typeName, tags.className], class: 'document-view-token-type' },
  { tag: [tags.tagName, tags.propertyName, tags.attributeName], class: 'document-view-token-property' },
])

export function ReadonlyCodeDocument({ document, onView }: {
  document: DocumentViewSnapshot
  onView(view: EditorView | null): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const onViewRef = useRef(onView)
  onViewRef.current = onView
  useLayoutEffect(() => {
    if (!host.current) return
    const language = new Compartment()
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: document.text,
        extensions: [
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ 'aria-label': '只读文档内容', tabindex: '0' }),
          ...(document.kind === 'code' ? [lineNumbers()] : []),
          search({ top: true }), keymap.of([...searchKeymap, ...defaultKeymap]),
          syntaxHighlighting(previewHighlightStyle), language.of([]),
          EditorState.phrases.of({ 'Find': '查找', 'next': '下一个', 'previous': '上一个', 'all': '全部', 'match case': '区分大小写', 'regexp': '正则表达式', 'by word': '整词' }),
        ],
      }),
    })
    let alive = true
    onViewRef.current(view)
    if (document.kind === 'code') {
      void loadCodeDocumentLanguage(document.absolutePath).then((extension) => {
        if (alive) view.dispatch({ effects: language.reconfigure(extension) })
      }).catch(() => { /* Literal text remains usable if a language pack is unavailable. */ })
    }
    return () => { alive = false; onViewRef.current(null); view.destroy() }
  }, [document.id, document.revision, document.text, document.kind, document.absolutePath])
  return <div className="document-view-code" ref={host} />
}

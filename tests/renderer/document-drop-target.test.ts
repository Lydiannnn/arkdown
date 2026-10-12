import { expect, it, vi } from 'vitest'
import { isDocumentBodyDrop } from '../../src/renderer/editor/document-drop-target'

it.each(['ProseMirror', 'cm-content'])('separates %s body text from padding and blank space', (className) => {
  const body = document.createElement('div')
  body.className = className
  body.style.padding = '20px 30px'
  const line = body.appendChild(document.createElement('p'))
  document.body.append(body)
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 600, 500))
  vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 70, 540, 30))
  expect(isDocumentBodyDrop(line, { clientX: 200, clientY: 85 })).toBe(true)
  expect(isDocumentBodyDrop(body, { clientX: 110, clientY: 85 })).toBe(false)
  expect(isDocumentBodyDrop(body, { clientX: 200, clientY: 450 })).toBe(false)
  expect(isDocumentBodyDrop(body, { clientX: 200, clientY: 55 })).toBe(false)
  expect(isDocumentBodyDrop(document.body, { clientX: 200, clientY: 85 })).toBe(false)
  body.remove()
})

it('measures padding in the same coordinate space as a zoomed editor', () => {
  const body = document.createElement('div')
  body.className = 'cm-content'
  body.style.padding = '20px'
  document.body.append(body)
  Object.defineProperty(body, 'offsetWidth', { value: 400 })
  Object.defineProperty(body, 'offsetHeight', { value: 200 })
  vi.spyOn(body, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 400))
  expect(isDocumentBodyDrop(body, { clientX: 30, clientY: 80 })).toBe(false)
  expect(isDocumentBodyDrop(body, { clientX: 50, clientY: 80 })).toBe(true)
  body.remove()
})

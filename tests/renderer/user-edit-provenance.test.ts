import { fireEvent } from '@testing-library/react'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserEditProvenance } from '../../src/renderer/editor/user-edit-provenance'

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
})

function createHarness() {
  const root = document.createElement('div')
  const editor = document.createElement('div')
  const toolbarButton = document.createElement('button')
  root.append(editor, toolbarButton)
  document.body.append(root)

  const provenance = createUserEditProvenance()
  const detach = provenance.attach(root)
  let state = EditorState.create({
    schema,
    plugins: [provenance.plugin],
  })
  const applyText = (text: string) => {
    state = state.apply(state.tr.insertText(text))
  }

  return {
    root,
    editor,
    toolbarButton,
    provenance,
    applyText,
    cleanup: () => {
      detach()
      provenance.destroy()
      root.remove()
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('user edit transaction provenance', () => {
  it('marks real toolbar and keyboard command document transactions', () => {
    const harness = createHarness()
    harness.toolbarButton.addEventListener('pointerdown', () => {
      harness.applyText('toolbar')
    })
    harness.editor.addEventListener('keydown', () => {
      harness.applyText('keyboard')
    })

    fireEvent.pointerDown(harness.toolbarButton)
    expect(harness.provenance.hasPending()).toBe(true)

    harness.provenance.consumePending()
    fireEvent.keyDown(harness.editor, { key: 'b', ctrlKey: true })
    expect(harness.provenance.hasPending()).toBe(true)
    harness.cleanup()
  })

  it('attributes pointerup and click transactions after pointerdown intent expires', async () => {
    const harness = createHarness()
    harness.toolbarButton.addEventListener('pointerup', () => {
      harness.applyText('pointerup')
    })
    harness.toolbarButton.addEventListener('click', () => {
      harness.applyText('click')
    })

    fireEvent.pointerDown(harness.toolbarButton)
    await Promise.resolve()
    expect(harness.provenance.hasPending()).toBe(false)
    fireEvent.pointerUp(harness.toolbarButton)
    expect(harness.provenance.hasPending()).toBe(true)

    harness.provenance.consumePending()
    fireEvent.pointerDown(harness.toolbarButton)
    await Promise.resolve()
    expect(harness.provenance.hasPending()).toBe(false)
    fireEvent.click(harness.toolbarButton)
    expect(harness.provenance.hasPending()).toBe(true)
    harness.cleanup()
  })

  it('expires no-op pointerup and click intent before later normalization', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    fireEvent.pointerUp(harness.editor)
    await Promise.resolve()
    harness.applyText('after no-op pointerup')
    expect(harness.provenance.hasPending()).toBe(false)

    fireEvent.click(harness.editor)
    await vi.advanceTimersByTimeAsync(0)
    harness.applyText('after no-op click')
    expect(harness.provenance.hasPending()).toBe(false)
    harness.cleanup()
  })

  it.each(['click', 'keydown', 'pointerdown'] as const)('keeps %s command intent through the native listener microtask checkpoint, then expires unused intent', async (event) => {
    vi.useFakeTimers()
    const harness = createHarness()
    const dispatch = () => event === 'pointerdown'
      ? fireEvent.pointerDown(harness.toolbarButton)
      : event === 'click'
        ? fireEvent.click(harness.toolbarButton)
        : fireEvent.keyDown(harness.editor, { key: 'z', ctrlKey: true })
    try {
      dispatch()
      await Promise.resolve()
      harness.applyText('native command')
      expect(harness.provenance.hasPending()).toBe(true)
      harness.provenance.consumePending()
      harness.applyText('unrelated transaction')
      expect(harness.provenance.hasPending()).toBe(false)

      dispatch()
      await vi.advanceTimersByTimeAsync(0)
      harness.applyText('later normalization')
      expect(harness.provenance.hasPending()).toBe(false)
    } finally {
      harness.cleanup()
    }
  })


  it('attributes mouse drag transactions used by table column resizing', () => {
    const harness = createHarness()
    harness.editor.addEventListener('mousemove', () => {
      harness.applyText('resize')
    })

    fireEvent.mouseMove(harness.editor, { buttons: 1 })
    expect(harness.provenance.hasPending()).toBe(true)
    harness.cleanup()
  })
  it('expires no-op input and paste intent before later normalization', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    harness.applyText('initial normalization')
    expect(harness.provenance.hasPending()).toBe(false)

    fireEvent.input(harness.editor)
    await vi.advanceTimersByTimeAsync(50)
    harness.applyText('after no-op input')
    expect(harness.provenance.hasPending()).toBe(false)

    fireEvent.paste(harness.editor)
    await vi.advanceTimersByTimeAsync(50)
    harness.applyText('after no-op paste')
    expect(harness.provenance.hasPending()).toBe(false)
    harness.cleanup()
  })

  it('attributes the queued input transaction before intent expires', async () => {
    const harness = createHarness()
    const mutationCheckpoint = Promise.resolve().then(() => {
      harness.applyText('typed')
    })

    fireEvent.input(harness.editor)
    await mutationCheckpoint

    expect(harness.provenance.hasPending()).toBe(true)
    harness.cleanup()
  })

  it('keeps native input intent through the ProseMirror DOM observer delay', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    fireEvent.input(harness.editor)
    await vi.advanceTimersByTimeAsync(20)
    harness.applyText('native input')

    expect(harness.provenance.hasPending()).toBe(true)
    harness.cleanup()
  })

  it.each(['Delete', 'Backspace'])(
    'keeps %s key intent through a delayed DOM observer transaction without input events',
    async (key) => {
      vi.useFakeTimers()
      const harness = createHarness()

      fireEvent.keyDown(harness.editor, { key })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(20)
      harness.applyText('keydown-only deletion transaction')

      expect(harness.provenance.hasPending()).toBe(true)
      harness.cleanup()
    },
  )

  it('expires a no-op Delete key before a later normalization transaction', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    fireEvent.keyDown(harness.editor, { key: 'Delete' })
    await vi.advanceTimersByTimeAsync(50)
    harness.applyText('later normalization')

    expect(harness.provenance.hasPending()).toBe(false)
    harness.cleanup()
  })

  it('requests a synchronous checkpoint while DOM input intent is still live', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    fireEvent.input(harness.editor, { inputType: 'deleteContentBackward' })

    expect(harness.provenance.hasPending()).toBe(false)
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(true)

    await vi.advanceTimersByTimeAsync(50)
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(false)
    harness.cleanup()
  })

  it('keeps requesting a checkpoint after the user transaction consumes live intent', () => {
    const harness = createHarness()

    fireEvent.input(harness.editor, { inputType: 'deleteContentForward' })
    harness.applyText('changed')

    expect(harness.provenance.hasPending()).toBe(true)
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(true)

    harness.provenance.consumePending()
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(false)
    harness.cleanup()
  })

  it.each([
    ['Delete', (editor: HTMLElement) => fireEvent.input(editor, { inputType: 'deleteContentForward' })],
    ['cut', (editor: HTMLElement) => fireEvent.cut(editor)],
  ])('requests a synchronous checkpoint for %s intent', (_name, dispatchIntent) => {
    const harness = createHarness()
    dispatchIntent(harness.editor)
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(true)
    harness.cleanup()
  })

  it('keeps composition intent through the DOMObserver checkpoint but bounds it', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.editor.addEventListener('compositionend', () => {
      queueMicrotask(() => harness.applyText('ime'))
    })

    fireEvent.compositionStart(harness.editor)
    fireEvent.compositionEnd(harness.editor)
    await Promise.resolve()
    expect(harness.provenance.hasPending()).toBe(true)

    harness.provenance.consumePending()
    await vi.runOnlyPendingTimersAsync()
    harness.applyText('later normalization')
    expect(harness.provenance.hasPending()).toBe(false)
    harness.cleanup()
  })

  it('expires an abandoned composition intent after bounded inactivity', async () => {
    vi.useFakeTimers()
    const harness = createHarness()

    fireEvent.compositionStart(harness.editor)
    fireEvent.input(harness.editor)
    await vi.advanceTimersByTimeAsync(5_000)
    harness.applyText('later normalization')
    expect(harness.provenance.hasPending()).toBe(false)
    expect(harness.provenance.needsSynchronousCheckpoint()).toBe(false)

    fireEvent.input(harness.editor)
    await vi.advanceTimersByTimeAsync(50)
    harness.applyText('normalization after abandoned composition')

    expect(harness.provenance.hasPending()).toBe(false)
    harness.cleanup()
  })
})

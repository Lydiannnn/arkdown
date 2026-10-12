import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { StickyNoteSummary } from '../../src/shared/contracts'
import { StickyNoteGrid } from '../../src/renderer/sticky-notes/StickyNoteGrid'
import { ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE } from '../../src/renderer/sticky-notes/archived-sticky-note-selection'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-box.css'), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]+)\\}', 's'))
  if (!match) throw new Error('Missing CSS rule for ' + selector)
  return match[1].replace(/\\s+/g, ' ')
}

const note: StickyNoteSummary = {
  record: {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Meeting notes',
    status: 'active',
    markdownRelativePath: 'active/note.md',
    resourcesRelativePath: 'active/assets',
    style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    archivedAt: null,
    released: false,
    pinned: false,
    fontSizePx: 13,
    lineSpacingMode: 'compact',
    windowBounds: null,
    lastOpenedAt: null,
  },
  excerpt: 'Action items',
}

// jsdom has no layout or native DragEvent coordinates. Model a three-column grid
// whose layout positions follow DOM order; visual rectangles may move independently.
function installGridLayout(grid: HTMLElement) {
  vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 30, 320, 500))
  for (const card of within(grid).getAllByRole('button')) {
    const index = () => Array.from(grid.children).indexOf(card)
    Object.defineProperties(card, {
      offsetLeft: { configurable: true, get: () => index() % 3 * 110 },
      offsetTop: { configurable: true, get: () => Math.floor(index() / 3) * 110 },
      offsetWidth: { configurable: true, get: () => 100 },
      offsetHeight: { configurable: true, get: () => 100 },
    })
    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() =>
      new DOMRect(20 + card.offsetLeft, 30 + card.offsetTop, 100, 100))
  }
}

function dragOverSlot(grid: HTMLElement, slot: number, dataTransfer: object) {
  const event = createEvent.dragOver(grid, { dataTransfer })
  Object.defineProperties(event, {
    clientX: { value: 20 + slot % 3 * 110 + 50 },
    clientY: { value: 30 + Math.floor(slot / 3) * 110 + 50 },
  })
  fireEvent(grid, event)
}

function reorderFixture(showCreate = true) {
  const notes = ['A', 'B', 'C', 'D'].map((name) => ({ ...note, record: { ...note.record, id: name, name } }))
  let settle!: (value: boolean) => void
  let reject!: (error: Error) => void
  const onReorder = vi.fn(() => new Promise<boolean>((resolve, fail) => { settle = resolve; reject = fail }))
  const onDragStateChange = vi.fn()
  const props = { label: 'notes', notes, onOpen: vi.fn(), onReorder, onDragStateChange, showCreate }
  const result = render(<StickyNoteGrid {...props} />)
  const grid = screen.getByRole('grid', { name: 'notes' })
  installGridLayout(grid)
  const cards = ['A', 'B', 'C', 'D'].map((name) => screen.getByRole('button', { name }))
  const animations: { card: HTMLElement; frames: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = []
  for (const card of within(grid).getAllByRole('button')) {
    Object.defineProperty(card, 'animate', { configurable: true, value: vi.fn((frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = { card, frames, options, cancel: vi.fn(), onfinish: null }
      animations.push(animation)
      return animation
    }) })
  }
  const transfer = { types: ['application/x-arknote-card'], effectAllowed: 'move', dropEffect: 'move', setData: vi.fn() }
  const labels = () => within(grid).getAllByRole('button').map((card) => card.getAttribute('aria-label'))
  return { ...result, props, grid, cards, transfer, labels, animations, onReorder, onDragStateChange,
    settle: (value: boolean) => act(async () => settle(value)), reject: () => act(async () => reject(new Error('save failed'))) }
}

describe('StickyNoteGrid', () => {
  it('uses a visible independent full-size image while the active source becomes an empty slot', () => {
    vi.useFakeTimers()
    try {
      const fixture = reorderFixture()
      const source = fixture.cards[0]!
      source.style.setProperty('--sticky-note-text-color', '#ffffff')
      const setDragImage = vi.fn()
      const transfer = { ...fixture.transfer, setDragImage }
      const event = createEvent.dragStart(source, { dataTransfer: transfer })
      Object.defineProperties(event, { clientX: { value: 155 }, clientY: { value: 65 } })
      fireEvent(source, event)
      expect(setDragImage).toHaveBeenCalledOnce()
      const [image, x, y] = setDragImage.mock.calls[0] as [HTMLElement, number, number]
      expect(image).not.toBe(source)
      expect(image.isConnected).toBe(true)
      expect(image).toHaveTextContent('Action items')
      expect(image).not.toHaveAttribute('data-reorder-slot')
      expect(image).not.toHaveClass('sticky-note-card-dragging')
      expect(image).toHaveStyle({ width: '100px', height: '100px', opacity: '1', pointerEvents: 'none' })
      expect(image.style.getPropertyValue('--sticky-note-text-color')).toBe('#ffffff')
      expect([x, y]).toEqual([25, 35])
      expect(source).toHaveAttribute('data-reorder-slot', 'empty')
      expect(source.parentElement).toBe(fixture.grid)
      expect(image).toHaveAttribute('aria-hidden', 'true')
      act(() => vi.runOnlyPendingTimers())
      expect(image.isConnected).toBe(false)
      expect(source.isConnected).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it.each(['dragend', 'unmount'] as const)('cleans the temporary drag image immediately on %s', lifecycle => {
    vi.useFakeTimers()
    try {
      const fixture = reorderFixture()
      const setDragImage = vi.fn()
      fireEvent.dragStart(fixture.cards[0], { dataTransfer: { ...fixture.transfer, setDragImage } })
      expect(setDragImage).toHaveBeenCalledOnce()
      const image = setDragImage.mock.calls[0]![0] as HTMLElement
      if (lifecycle === 'dragend') fireEvent.dragEnd(fixture.cards[0], { dataTransfer: fixture.transfer })
      else fixture.unmount()
      expect(image.isConnected).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('slides displaced cards across rows for 400ms, keeping the source and create card still', () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
    expect(fixture.animations.map(({ card }) => card.getAttribute('aria-label'))).toEqual(['B', 'C'])
    expect(fixture.animations[0].frames).toEqual([{ transform: 'translate(110px, 0px)' }, { transform: 'translate(0px, 0px)' }])
    expect(fixture.animations[1].frames).toEqual([{ transform: 'translate(-220px, 110px)' }, { transform: 'translate(0px, 0px)' }])
    expect(fixture.animations.every(({ options }) => options.duration === 400)).toBe(true)
    expect(fixture.cards[0]).toHaveAttribute('data-reorder-slot', 'empty')
    expect(fixture.cards[0].parentElement).toBe(fixture.grid)
    expect(rule('.sticky-note-grid[data-interaction-mode="active"] .sticky-note-card[data-reorder-slot="empty"]')).toMatch(/opacity:\s*0/)
    fireEvent.dragEnd(fixture.cards[0], { dataTransfer: fixture.transfer })
    expect(fixture.cards[0]).not.toHaveAttribute('data-reorder-slot')
  })

  it('uses layout cells while animations cross the cursor and resumes from current visual positions', () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 2, fixture.transfer)
    const previous = fixture.animations[0]
    vi.mocked(fixture.cards[1].getBoundingClientRect).mockImplementation(() =>
      new DOMRect(previous.cancel.mock.calls.length ? 130 : 190, 30, 100, 100))
    fireEvent.dragEnter(fixture.cards[1], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 2, fixture.transfer)
    dragOverSlot(fixture.grid, 2, fixture.transfer)
    expect(fixture.labels()).toEqual(['新便签', 'B', 'A', 'C', 'D'])
    expect(fixture.animations).toHaveLength(1)
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    expect(previous.cancel).toHaveBeenCalledOnce()
    expect(fixture.animations[1].frames[0]).toEqual({ transform: 'translate(60px, 0px)' })
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
    dragOverSlot(fixture.grid, 0, fixture.transfer)
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
  })

  it('keeps the preview order through dragEnd while saving and rejects new drags until settled', async () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
    fireEvent.dragEnd(fixture.cards[0], { dataTransfer: fixture.transfer })
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
    expect(fixture.cards[1]).toHaveAttribute('draggable', 'false')
    const start = createEvent.dragStart(fixture.cards[1], { dataTransfer: fixture.transfer })
    fireEvent(fixture.cards[1], start)
    expect(start.defaultPrevented).toBe(true)
    fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
    expect(fixture.onReorder).toHaveBeenCalledExactlyOnceWith(['B', 'C', 'A', 'D'])
    await fixture.settle(true)
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
    expect(fixture.grid).toHaveAttribute('data-dragging', 'false')
    expect(fixture.cards[1]).toHaveAttribute('draggable', 'true')
  })

  it.each(['false', 'throw'] as const)('rolls back a %s persistence result after native dragEnd', async (failure) => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
    fireEvent.dragEnd(fixture.cards[0], { dataTransfer: fixture.transfer })
    if (failure === 'false') await fixture.settle(false)
    else await fixture.reject()
    expect(fixture.labels()).toEqual(['新便签', 'A', 'B', 'C', 'D'])
    expect(fixture.grid).toHaveAttribute('data-dragging', 'false')
  })

  it('restores a cancelled drag and cancels animation resources on unmount', () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    fireEvent.dragEnd(fixture.cards[0], { dataTransfer: fixture.transfer })
    expect(fixture.labels()).toEqual(['新便签', 'A', 'B', 'C', 'D'])
    expect(fixture.onReorder).not.toHaveBeenCalled()
    fixture.unmount()
    expect(fixture.animations.length).toBeGreaterThan(0)
    expect(fixture.animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true)
  })

  it('honors reduced motion while still reordering and persisting cards', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    try {
      const fixture = reorderFixture()
      fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
      dragOverSlot(fixture.grid, 3, fixture.transfer)
      expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
      expect(fixture.animations).toHaveLength(0)
      fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
      await fixture.settle(true)
      expect(fixture.onReorder).toHaveBeenCalledExactlyOnceWith(['B', 'C', 'A', 'D'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies a refreshed order and ignores a stale pending drop result', async () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
    fixture.rerender(<StickyNoteGrid {...fixture.props} notes={[fixture.props.notes[3], fixture.props.notes[0]]} />)
    expect(fixture.labels()).toEqual(['新便签', 'D', 'A'])
    expect(fixture.animations.every(({ cancel }) => cancel.mock.calls.length === 1)).toBe(true)
    expect(fixture.cards[0]).toHaveAttribute('draggable', 'false')
    await fixture.settle(false)
    expect(fixture.labels()).toEqual(['新便签', 'D', 'A'])
    expect(fixture.cards[0]).toHaveAttribute('draggable', 'true')
  })

  it('lets an in-flight slide finish when persistence echoes the displayed order', async () => {
    const fixture = reorderFixture()
    fireEvent.dragStart(fixture.cards[0], { dataTransfer: fixture.transfer })
    dragOverSlot(fixture.grid, 3, fixture.transfer)
    fireEvent.drop(fixture.grid, { dataTransfer: fixture.transfer })
    fixture.rerender(<StickyNoteGrid {...fixture.props}
      notes={[fixture.props.notes[1], fixture.props.notes[2], fixture.props.notes[0], fixture.props.notes[3]]} />)
    expect(fixture.animations.every(({ cancel }) => cancel.mock.calls.length === 0)).toBe(true)
    await fixture.settle(true)
    expect(fixture.labels()).toEqual(['新便签', 'B', 'C', 'A', 'D'])
  })

  it('previews archived cards with Enter and selects them with Space without duplicate clicks', async () => {
    const user = userEvent.setup()
    const archived = { ...note, record: { ...note.record, status: 'archived' as const } }
    const onOpenArchived = vi.fn()
    const onSelectArchived = vi.fn()
    render(<StickyNoteGrid interactionMode="archive" label="archives" notes={[archived]}
      onArchiveDragStart={() => [archived.record.id]} onMarqueeChange={vi.fn()}
      onOpenArchived={onOpenArchived} onSelectArchived={onSelectArchived} selectedIds={new Set()} />)
    screen.getByRole('button', { name: archived.record.name }).focus()
    await user.keyboard('{Enter}')
    expect(onOpenArchived).toHaveBeenCalledExactlyOnceWith(archived)
    expect(onSelectArchived).not.toHaveBeenCalled()
    await user.keyboard(' ')
    expect(onSelectArchived).toHaveBeenCalledExactlyOnceWith(archived, { ctrlKey: false, shiftKey: false })
    expect(onOpenArchived).toHaveBeenCalledTimes(1)
  })

  it('renders the compact new-note entry and an unbold card title', () => {
    render(<StickyNoteGrid label="notes" notes={[note]} onOpen={vi.fn()} showCreate />)

    expect(screen.getByRole('button', { name: '新便签' })).toHaveTextContent('+新便签')
    expect(screen.getByRole('button', { name: 'Meeting notes' })).toHaveTextContent('Meeting notes')
    expect(rule('.sticky-note-card-paper strong')).toContain('font-weight: var(--ui-font-weight-normal)')
    expect(rule('.sticky-note-card-paper strong')).toContain('color: color-mix(in srgb, var(--sticky-note-text-color) 50%, transparent)')
    expect(rule('.sticky-note-create-card')).toContain('font-size: 13px')
  })

  it('renders material cards with an opaque fallback and static material identity', () => {
    const materialNote: StickyNoteSummary = {
      ...note,
      record: {
        ...note.record,
        style: { mode: 'material', materialPresetId: 'flowing-glass' },
      },
    }
    render(<StickyNoteGrid
      label="notes"
      notes={[materialNote]}
      onOpen={vi.fn()}
      showCreate={false}
    />)

    const card = screen.getByRole('button', { name: 'Meeting notes' })
    expect(card).toHaveAttribute('data-material-preset', 'flowing-glass')
    expect(card.style.getPropertyValue('--sticky-note-background-color')).toBe('#E9EEF2')
    expect(card.style.getPropertyValue('--sticky-note-preview-background-color')).toBe('#E9EEF2')

    fireEvent.pointerMove(card, { clientX: 80, clientY: 120 })
    expect(card.style.getPropertyValue('--flowing-glass-pointer-x')).toBe('')
    expect(card.style.getPropertyValue('--flowing-glass-pointer-y')).toBe('')
  })

  it('reorders active cards while dragging and persists the final order on drop', async () => {
    const second = { ...note, record: { ...note.record, id: '10000000-0000-4000-8000-000000000002', name: 'Second note' } }
    const onReorder = vi.fn(async () => true)
    render(<StickyNoteGrid label="notes" notes={[note, second]} onOpen={vi.fn()} onReorder={onReorder} showCreate />)
    const grid = screen.getByRole('grid', { name: 'notes' })
    installGridLayout(grid)
    const transfer = { types: ['application/x-arknote-card'], effectAllowed: 'move', dropEffect: 'move', setData: vi.fn(), getData: vi.fn(() => note.record.id), files: [] as unknown as FileList }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Meeting notes' }), { dataTransfer: transfer })
    dragOverSlot(grid, 2, transfer)
    expect(within(grid).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['新便签', 'Second note', 'Meeting notes'])
    fireEvent.drop(screen.getByRole('button', { name: 'Second note' }), { dataTransfer: transfer })
    expect(onReorder).toHaveBeenCalledWith([second.record.id, note.record.id])
  })

  it('restores the server order when persisting a dragged order fails', async () => {
    const second = { ...note, record: { ...note.record, id: '10000000-0000-4000-8000-000000000002', name: 'Second note' } }
    const onReorder = vi.fn(async () => false)
    render(<StickyNoteGrid label="notes" notes={[note, second]} onOpen={vi.fn()} onReorder={onReorder} showCreate={false} />)
    const grid = screen.getByRole('grid', { name: 'notes' })
    installGridLayout(grid)
    const transfer = { types: ['application/x-arknote-card'], effectAllowed: 'move', dropEffect: 'move', setData: vi.fn(), getData: vi.fn(() => note.record.id), files: [] as unknown as FileList }
    fireEvent.dragStart(screen.getByRole('button', { name: 'Meeting notes' }), { dataTransfer: transfer })
    dragOverSlot(grid, 1, transfer)
    fireEvent.drop(screen.getByRole('button', { name: 'Second note' }), { dataTransfer: transfer })
    await screen.findByRole('button', { name: 'Meeting notes' })
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Meeting notes', 'Second note'])
  })

  it('keeps active-page drag reorder behavior when archive interactions are available', () => {
    const second = { ...note, record: { ...note.record, id: '10000000-0000-4000-8000-000000000002', name: 'Second note' } }
    const onReorder = vi.fn(async () => true)
    render(<StickyNoteGrid label="notes" notes={[note, second]} onOpen={vi.fn()} onReorder={onReorder} showCreate={false} />)
    const grid = screen.getByRole('grid', { name: 'notes' })
    installGridLayout(grid)
    const transfer = { types: ['application/x-arknote-card'], effectAllowed: 'move', dropEffect: 'move', setData: vi.fn(), getData: vi.fn(() => note.record.id), files: [] as unknown as FileList }

    fireEvent.dragStart(screen.getByRole('button', { name: 'Meeting notes' }), { dataTransfer: transfer })
    dragOverSlot(grid, 1, transfer)
    fireEvent.drop(screen.getByRole('button', { name: 'Second note' }), { dataTransfer: transfer })

    expect(onReorder).toHaveBeenCalledWith([second.record.id, note.record.id])
  })

  it('selects archived cards with exact modifiers and opens them only on double-click', () => {
    const archived = { ...note, record: { ...note.record, status: 'archived' as const, archivedAt: note.record.updatedAt } }
    const onSelectArchived = vi.fn()
    const onOpenArchived = vi.fn()
    render(<StickyNoteGrid
      interactionMode="archive"
      label="archives"
      notes={[archived]}
      onArchiveDragStart={() => [archived.record.id]}
      onMarqueeChange={vi.fn()}
      onOpenArchived={onOpenArchived}
      onSelectArchived={onSelectArchived}
      selectedIds={new Set()}
    />)
    const card = screen.getByRole('button', { name: archived.record.name })

    fireEvent.click(card, { ctrlKey: true, shiftKey: true })
    expect(onSelectArchived).toHaveBeenCalledWith(archived, { ctrlKey: true, shiftKey: true })
    expect(onOpenArchived).not.toHaveBeenCalled()

    fireEvent.doubleClick(card)
    expect(onOpenArchived).toHaveBeenCalledWith(archived)
  })

  it('captures pointer marquee only from whitespace and reports fixed-rectangle hits from pointerdown', () => {
    const archived = { ...note, record: { ...note.record, status: 'archived' as const, archivedAt: note.record.updatedAt } }
    const second = { ...archived, record: { ...archived.record, id: '10000000-0000-4000-8000-000000000002', name: 'Second note' } }
    const onMarqueeChange = vi.fn()
    render(<StickyNoteGrid
      interactionMode="archive"
      label="archives"
      notes={[archived, second]}
      onArchiveDragStart={() => [archived.record.id]}
      onMarqueeChange={onMarqueeChange}
      onOpenArchived={vi.fn()}
      onSelectArchived={vi.fn()}
      selectedIds={new Set()}
    />)
    const grid = screen.getByRole('grid', { name: 'archives' })
    const firstCard = screen.getByRole('button', { name: archived.record.name })
    const secondCard = screen.getByRole('button', { name: second.record.name })
    Object.defineProperty(grid, 'setPointerCapture', { configurable: true, value: vi.fn() })
    Object.defineProperty(grid, 'releasePointerCapture', { configurable: true, value: vi.fn() })
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
    vi.spyOn(firstCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 20, 80, 80))
    vi.spyOn(secondCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(140, 20, 80, 80))

    fireEvent.pointerDown(firstCard, { pointerId: 1, clientX: 25, clientY: 25 })
    expect(grid.setPointerCapture).not.toHaveBeenCalled()

    fireEvent.pointerDown(grid, { pointerId: 7, clientX: 10, clientY: 10, ctrlKey: true })
    fireEvent.pointerMove(grid, { pointerId: 7, clientX: 110, clientY: 110, ctrlKey: false })
    expect(screen.getByTestId('sticky-note-selection-marquee')).toHaveStyle({ left: '10px', top: '10px', width: '100px', height: '100px' })
    fireEvent.pointerUp(grid, { pointerId: 7, clientX: 110, clientY: 110 })

    expect(grid.setPointerCapture).toHaveBeenCalledWith(7)
    expect(grid.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(onMarqueeChange).toHaveBeenCalledWith([archived.record.id], true)
  })

  it('encodes the selected archived group and exposes dragging state', () => {
    const archived = { ...note, record: { ...note.record, status: 'archived' as const, archivedAt: note.record.updatedAt } }
    const secondId = '10000000-0000-4000-8000-000000000002'
    const onArchiveDragStart = vi.fn(() => [archived.record.id, secondId])
    render(<StickyNoteGrid
      interactionMode="archive"
      label="archives"
      notes={[archived]}
      onArchiveDragStart={onArchiveDragStart}
      onMarqueeChange={vi.fn()}
      onOpenArchived={vi.fn()}
      onSelectArchived={vi.fn()}
      selectedIds={new Set([archived.record.id])}
    />)
    const grid = screen.getByRole('grid', { name: 'archives' })
    const card = screen.getByRole('button', { name: archived.record.name })
    const transfer = { types: [] as string[], effectAllowed: 'move', setData: vi.fn() }

    fireEvent.dragStart(card, { dataTransfer: transfer })

    expect(onArchiveDragStart).toHaveBeenCalledWith(archived)
    expect(transfer.setData).toHaveBeenCalledWith(
      ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE,
      JSON.stringify([archived.record.id, secondId]),
    )
    expect(grid).toHaveAttribute('data-dragging', 'true')
    fireEvent.dragEnd(card, { dataTransfer: transfer })
    expect(grid).toHaveAttribute('data-dragging', 'false')
  })

  it('uses only visible selected archive cards in the native group drag image', () => {
    const archived = { ...note, record: { ...note.record, status: 'archived' as const, archivedAt: note.record.updatedAt } }
    const second = {
      ...archived,
      record: { ...archived.record, id: '10000000-0000-4000-8000-000000000002', name: 'Second note' },
    }
    const onDragStateChange = vi.fn()
    render(<div className="sticky-note-box-content"><StickyNoteGrid
      interactionMode="archive"
      label="archives"
      notes={[archived, second]}
      onArchiveDragStart={() => [archived.record.id, second.record.id]}
      onDragStateChange={onDragStateChange}
      onMarqueeChange={vi.fn()}
      onOpenArchived={vi.fn()}
      onSelectArchived={vi.fn()}
      selectedIds={new Set([archived.record.id, second.record.id])}
    /></div>)
    const grid = screen.getByRole('grid', { name: 'archives' })
    const viewport = grid.closest<HTMLElement>('.sticky-note-box-content')!
    const firstCard = screen.getByRole('button', { name: archived.record.name })
    const secondCard = screen.getByRole('button', { name: second.record.name })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 220))
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 800))
    vi.spyOn(firstCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 70, 70))
    vi.spyOn(secondCard, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 400, 70, 70))
    const setDragImage = vi.fn()
    const transfer = { types: [] as string[], effectAllowed: 'move', setData: vi.fn(), setDragImage }

    fireEvent.dragStart(firstCard, { dataTransfer: transfer })

    expect(setDragImage).toHaveBeenCalledOnce()
    const preview = setDragImage.mock.calls[0][0] as HTMLElement
    expect(preview).toHaveClass('sticky-note-drag-preview')
    expect(preview.querySelectorAll('[data-sticky-note-drag-preview-card]')).toHaveLength(1)
    expect(preview).toHaveTextContent(archived.record.name)
    expect(preview).not.toHaveTextContent(second.record.name)
    expect(onDragStateChange).toHaveBeenLastCalledWith(true)

    fireEvent.dragEnd(firstCard, { dataTransfer: transfer })
    expect(onDragStateChange).toHaveBeenLastCalledWith(false)
  })

})

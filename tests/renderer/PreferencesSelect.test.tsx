import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { PreferencesSelect } from '../../src/renderer/settings/PreferencesSelect'

const options = [
  { value: 'bing', label: 'Bing（默认）' },
  { value: 'baidu', label: '百度' },
  { value: 'google', label: 'Google' },
] as const

it('renders an accessible vector caret while preserving ArrowDown and Enter selection', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(
    <PreferencesSelect
      label="Caret control"
      onChange={onChange}
      options={options}
      value="bing"
    />,
  )

  const trigger = screen.getByRole('combobox', { name: 'Caret control' })
  const chevron = trigger.querySelector('.preferences-select-chevron')
  const caret = chevron?.querySelector('svg')
  expect(caret).toHaveAttribute('width', '14')
  expect(caret).toHaveAttribute('height', '14')
  expect(caret).toHaveAttribute('aria-hidden', 'true')
  expect(Array.from(chevron?.childNodes ?? [])).not.toContainEqual(
    expect.objectContaining({ nodeType: Node.TEXT_NODE }),
  )

  trigger.focus()
  await user.keyboard('{ArrowDown}{Enter}')
  expect(onChange).toHaveBeenCalledWith('bing')
})

it('opens a homepage-style listbox and selects a visible option', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(
    <PreferencesSelect
      label="搜索提供商"
      onChange={onChange}
      options={options}
      value="bing"
    />,
  )

  const trigger = screen.getByRole('combobox', { name: '搜索提供商' })
  expect(trigger).toHaveTextContent('Bing（默认）')
  await user.click(trigger)

  const listbox = screen.getByRole('listbox', { name: '搜索提供商' })
  expect(listbox).toHaveClass('preferences-select-menu')
  expect(screen.getAllByRole('option')).toHaveLength(3)
  const selected = screen.getByRole('option', { name: 'Bing（默认）' })
  expect(selected.querySelector('.preferences-select-check svg')).toBeInTheDocument()
  expect(selected.querySelector('.preferences-select-check')).not.toHaveTextContent('✓')
  await user.click(screen.getByRole('option', { name: '百度' }))

  expect(onChange).toHaveBeenCalledWith('baidu')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('supports menu keyboard navigation and Escape focus restoration', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(
    <PreferencesSelect
      label="搜索提供商"
      onChange={onChange}
      options={options}
      value="bing"
    />,
  )

  const trigger = screen.getByRole('combobox', { name: '搜索提供商' })
  trigger.focus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('option', { name: 'Bing（默认）' })).toHaveFocus()
  await user.keyboard('{End}{Enter}')
  expect(onChange).toHaveBeenCalledWith('google')
  expect(trigger).toHaveFocus()

  await user.keyboard('{Enter}')
  expect(screen.getByRole('listbox')).toBeVisible()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

it('does not open when disabled', async () => {
  const user = userEvent.setup()
  render(
    <PreferencesSelect
      disabled
      label="接入类型"
      onChange={() => undefined}
      options={[{ value: 'api', label: '标准 API' }]}
      value="api"
    />,
  )

  const trigger = screen.getByRole('combobox', { name: '接入类型' })
  expect(trigger).toBeDisabled()
  await user.click(trigger)
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
})

it('retains a caller supplied layout class on its 32px combobox trigger', () => {
  render(
    <PreferencesSelect
      className="large-model-assignment-select"
      label="划词翻译模型"
      onChange={() => undefined}
      options={[{ value: 'model', label: '主翻译模型' }]}
      value="model"
    />,
  )

  expect(screen.getByRole('combobox', { name: '划词翻译模型' }))
    .toHaveClass('large-model-assignment-select')
})

it('keeps a long font menu open when it scrolls internally to the selected option', async () => {
  const user = userEvent.setup()
  const longFontName = 'Microsoft YaHei & Microsoft YaHei UI Bold & Microsoft YaHei Light'
  const fontOptions = Array.from({ length: 40 }, (_, index) => ({
    value: `font-${index}`,
    label: index === 39 ? longFontName : `字体 ${index}`,
  }))
  render(
    <PreferencesSelect
      label="标题中文"
      onChange={() => undefined}
      options={fontOptions}
      value="font-39"
    />,
  )

  await user.click(screen.getByRole('combobox', { name: '标题中文' }))
  const listbox = screen.getByRole('listbox', { name: '标题中文' })
  const selectedOption = screen.getByRole('option', { name: longFontName })
  fireEvent.scroll(listbox)

  expect(screen.getByRole('listbox', { name: '标题中文' })).toBeVisible()
  expect(selectedOption).toHaveAttribute('data-tooltip', longFontName)
  expect(selectedOption).not.toHaveAttribute('title')
  expect(selectedOption.querySelector('.preferences-select-option-label')).not.toBeNull()
})

it('focuses the selected option without letting browser focus scroll close the menu', async () => {
  const user = userEvent.setup()
  const nativeFocus = HTMLElement.prototype.focus
  const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    nativeFocus.call(this, options)
    if (this.getAttribute('role') === 'option' && !options?.preventScroll) {
      fireEvent.scroll(document)
    }
  })

  try {
    render(
      <PreferencesSelect
        label="Focus guard"
        onChange={() => undefined}
        options={options}
        value="bing"
      />,
    )

    await user.click(screen.getByRole('combobox', { name: 'Focus guard' }))

    expect(screen.getByRole('listbox', { name: 'Focus guard' })).toBeVisible()
    expect(screen.getByRole('option', { selected: true })).toHaveFocus()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  } finally {
    focus.mockRestore()
  }
})

it('ignores the tail of a pre-open external scroll but closes for a new scroll after scrollend', async () => {
  const user = userEvent.setup()
  render(
    <div data-testid="preferences-scroller">
      <PreferencesSelect
        label="Scroll sequence guard"
        onChange={() => undefined}
        options={options}
        value="bing"
      />
    </div>,
  )

  const scroller = screen.getByTestId('preferences-scroller')
  fireEvent.scroll(scroller)
  await user.click(screen.getByRole('combobox', { name: 'Scroll sequence guard' }))
  expect(screen.getByRole('listbox', { name: 'Scroll sequence guard' })).toBeVisible()

  fireEvent.scroll(scroller)
  expect(screen.getByRole('listbox', { name: 'Scroll sequence guard' })).toBeVisible()

  fireEvent(scroller, new Event('scrollend'))
  fireEvent.scroll(scroller)
  expect(screen.queryByRole('listbox', { name: 'Scroll sequence guard' })).not.toBeInTheDocument()
})

it('ends the ignored opening scroll sequence after the deterministic quiet fallback', () => {
  vi.useFakeTimers()
  try {
    render(
      <div data-testid="fallback-scroller">
        <PreferencesSelect
          label="Fallback guard"
          onChange={() => undefined}
          options={options}
          value="bing"
        />
      </div>,
    )

    const scroller = screen.getByTestId('fallback-scroller')
    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByRole('combobox', { name: 'Fallback guard' }))
    fireEvent.scroll(scroller)
    expect(screen.getByRole('listbox', { name: 'Fallback guard' })).toBeVisible()

    act(() => vi.advanceTimersByTime(120))
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('listbox', { name: 'Fallback guard' })).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})


it.each([
  ['wheel', (target: HTMLElement) => fireEvent.wheel(target)],
  ['touchstart', (target: HTMLElement) => fireEvent.touchStart(target)],
  ['keyboard scroll', (target: HTMLElement) => fireEvent.keyDown(target, { key: 'PageDown' })],
])('closes when a new %s intent starts inside the ignored opening scroller', (_name, sendIntent) => {
  render(
    <div data-testid="intent-scroller">
      <span data-testid="intent-child" />
      <PreferencesSelect
        label="Intent guard"
        onChange={() => undefined}
        options={options}
        value="bing"
      />
    </div>,
  )

  const scroller = screen.getByTestId('intent-scroller')
  fireEvent.scroll(scroller)
  fireEvent.click(screen.getByRole('combobox', { name: 'Intent guard' }))
  fireEvent.scroll(scroller)
  expect(screen.getByRole('listbox', { name: 'Intent guard' })).toBeVisible()

  sendIntent(screen.getByTestId('intent-child'))
  expect(screen.queryByRole('listbox', { name: 'Intent guard' })).not.toBeInTheDocument()
})

it.each([
  ['document', 'wheel', (target: HTMLElement) => fireEvent.wheel(target)],
  ['document', 'touchstart', (target: HTMLElement) => fireEvent.touchStart(target)],
  ['document', 'keyboard scroll', (target: HTMLElement) => (
    fireEvent.keyDown(target, { key: 'PageDown' })
  )],
  ['window', 'wheel', (target: HTMLElement) => fireEvent.wheel(target)],
  ['window', 'touchstart', (target: HTMLElement) => fireEvent.touchStart(target)],
  ['window', 'keyboard scroll', (target: HTMLElement) => (
    fireEvent.keyDown(target, { key: 'PageDown' })
  )],
])(
  'keeps menu-internal %s-target %s intent inside the menu',
  (openingTargetName, _intentName, sendIntent) => {
    render(
      <PreferencesSelect
        label="Menu intent guard"
        onChange={() => undefined}
        options={options}
        value="bing"
      />,
    )

    const openingTarget = openingTargetName === 'document' ? document : window
    fireEvent.scroll(openingTarget)
    fireEvent.click(screen.getByRole('combobox', { name: 'Menu intent guard' }))
    const listbox = screen.getByRole('listbox', { name: 'Menu intent guard' })
    fireEvent.scroll(openingTarget)
    expect(listbox).toBeVisible()

    sendIntent(screen.getByRole('option', { selected: true }))
    expect(listbox).toBeVisible()
  },
)

it('clears inherited scroll state and its timer when closing before a quick reopen', () => {
  vi.useFakeTimers()
  try {
    render(
      <div data-testid="reopen-scroller">
        <PreferencesSelect
          label="Reopen guard"
          onChange={() => undefined}
          options={options}
          value="bing"
        />
      </div>,
    )

    const scroller = screen.getByTestId('reopen-scroller')
    const trigger = screen.getByRole('combobox', { name: 'Reopen guard' })
    fireEvent.scroll(scroller)
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox', { name: 'Reopen guard' })).not.toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)

    fireEvent.click(trigger)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('listbox', { name: 'Reopen guard' })).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

it('caps an active ignored scroll sequence at 400 milliseconds', () => {
  vi.useFakeTimers()
  try {
    render(
      <div data-testid="deadline-scroller">
        <PreferencesSelect
          label="Deadline guard"
          onChange={() => undefined}
          options={options}
          value="bing"
        />
      </div>,
    )

    const scroller = screen.getByTestId('deadline-scroller')
    fireEvent.scroll(scroller)
    fireEvent.click(screen.getByRole('combobox', { name: 'Deadline guard' }))
    fireEvent.scroll(scroller)
    for (let elapsed = 100; elapsed < 400; elapsed += 100) {
      act(() => vi.advanceTimersByTime(100))
      fireEvent.scroll(scroller)
      expect(screen.getByRole('listbox', { name: 'Deadline guard' })).toBeVisible()
    }

    act(() => vi.advanceTimersByTime(100))
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('listbox', { name: 'Deadline guard' })).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

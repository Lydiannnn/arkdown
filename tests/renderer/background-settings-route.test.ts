import { describe, expect, it } from 'vitest'
import { backgroundSettingsRouteFromLocation } from '../../src/renderer/backgrounds/background-settings-route'

const NOTE_ID = '11111111-2222-4333-8444-555555555555'

describe('backgroundSettingsRouteFromLocation', () => {
  it('parses the main-editor background settings target', () => {
    expect(backgroundSettingsRouteFromLocation('?surface=background-settings&target=main'))
      .toEqual({ target: 'main' })
  })

  it.each(['minimal', 'dark', 'system'])('accepts one valid initial theme for either target (%s)', theme => {
    expect(backgroundSettingsRouteFromLocation(`?surface=background-settings&target=main&theme=${theme}`)).toEqual({ target: 'main' })
    expect(backgroundSettingsRouteFromLocation(`?surface=background-settings&target=sticky-note&noteId=${NOTE_ID}&theme=${theme}`))
      .toEqual({ target: 'sticky-note', noteId: NOTE_ID })
  })

  it('parses a sticky-note target only with a canonical note ID', () => {
    expect(backgroundSettingsRouteFromLocation(
      `?surface=background-settings&target=sticky-note&noteId=${NOTE_ID}`,
    )).toEqual({ noteId: NOTE_ID, target: 'sticky-note' })
  })

  it.each([
    '',
    '?surface=background-settings',
    '?surface=background-settings&target=main&noteId=11111111-2222-4333-8444-555555555555',
    '?surface=background-settings&target=sticky-note',
    '?surface=background-settings&target=sticky-note&noteId=11111111-2222-4333-8444-555555555555&noteId=11111111-2222-4333-8444-555555555555',
    '?surface=background-settings&target=sticky-note&noteId=11111111-2222-4333-8444-555555555555&extra=value',
    '?surface=background-settings&target=sticky-note&noteId=11111111-2222-4333-8444-555555555555'.toUpperCase(),
    '?surface=sticky-note&target=main',
    '?surface=background-settings&target=main&theme=dark&theme=dark',
    '?surface=background-settings&target=main&theme=invalid',
  ])('rejects malformed background settings query %s', (search) => {
    expect(backgroundSettingsRouteFromLocation(search)).toBeNull()
  })
})

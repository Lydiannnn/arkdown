import { fireEvent, screen } from '@testing-library/react'

export function choosePreferencesOption(label: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

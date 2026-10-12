export type WelcomeAction = 'choose-workspace' | 'new-document'
export function welcomeActionForLink(href: unknown): WelcomeAction | null {
  if (href === 'arkdown:choose-workspace') return 'choose-workspace'
  if (href === 'arkdown:new-document') return 'new-document'
  return null
}

import './styles'
import { lazy, Suspense, type ReactNode } from 'react'
const ScreenTranslationSurface = lazy(() => import('./screen-translation/ScreenTranslationSurface').then(module => ({ default: module.ScreenTranslationSurface })))
const RuntimeInstallerSurface = lazy(() => import('./components/RuntimeInstallerSurface').then(module => ({ default: module.RuntimeInstallerSurface })))
const MermaidViewerSurface = lazy(() => import('./mermaid-viewer/MermaidViewerSurface').then(module => ({ default: module.MermaidViewerSurface })))
const CloseRecoverySurface = lazy(() => import('./close/CloseRecoverySurface').then(module => ({ default: module.CloseRecoverySurface })))
const BusinessMessageSurface = lazy(() => import('./modal/BusinessMessageSurface').then(module => ({ default: module.BusinessMessageSurface })))
import { startModelRulesInitialization } from './settings/model-rules-runtime'
import { applyMainWindowTheme, initialMainWindowTheme } from './app/main-window-theme'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
const App = lazy(() => import('./app/App').then(module => ({ default: module.App })))
import { ContextMenuProvider } from './context-menu/ContextMenuProvider'
import { TooltipProvider } from './tooltip/TooltipProvider'
const StickyNoteWindowRoot = lazy(() => import('./sticky-notes/StickyNoteWindowRoot').then(module => ({ default: module.StickyNoteWindowRoot })))
import { stickyNoteRouteFromLocation } from './sticky-notes/sticky-note-route'
const ArknoteBoxWindowRoot = lazy(() => import('./sticky-notes/ArknoteBoxWindowRoot').then(module => ({ default: module.ArknoteBoxWindowRoot })))
const ArknoteSettingsPage = lazy(() => import('./settings/ArknoteSettingsPage').then(module => ({ default: module.ArknoteSettingsPage })))
const ExternalContextMenuSurface = lazy(() => import('./context-menu/ExternalContextMenuSurface').then(module => ({ default: module.ExternalContextMenuSurface })))
const PrintDocumentSurface = lazy(() => import('./printing/PrintDocumentSurface').then(module => ({ default: module.PrintDocumentSurface })))
const ScreenshotSelectionSurface = lazy(() => import('./screenshot/ScreenshotSelectionSurface').then(module => ({ default: module.ScreenshotSelectionSurface })))
const ScreenshotTranslationWindow = lazy(() => import('./screenshot/ScreenshotTranslationWindow').then(module => ({ default: module.ScreenshotTranslationWindow })))
import { BusinessDialogProvider } from './modal/BusinessDialogProvider'
const BackgroundSettingsSurface = lazy(() => import('./backgrounds/BackgroundSettingsSurface').then(module => ({ default: module.BackgroundSettingsSurface })))
import { backgroundSettingsRouteFromLocation } from './backgrounds/background-settings-route'

const stickyNoteRoute = stickyNoteRouteFromLocation(window.location.search)
const backgroundSettingsRoute = backgroundSettingsRouteFromLocation(window.location.search)
const surface = new URLSearchParams(window.location.search).get('surface')
const printToken = new URLSearchParams(window.location.search).get('token') ?? ''
const screenshotSessionId = new URLSearchParams(window.location.search).get('sessionId') ?? ''
const screenshotDisplayId = new URLSearchParams(window.location.search).get('displayId') ?? ''

if ((!surface && !stickyNoteRoute && !backgroundSettingsRoute) || backgroundSettingsRoute) {
  applyMainWindowTheme(initialMainWindowTheme())
}

const root = createRoot(document.getElementById('root')!)

function renderSurface(surface: ReactNode) {
  root.render(<Suspense fallback={<div role="status" aria-label="正在加载" />}>{surface}</Suspense>)
}

function renderRoot() {
if (surface === 'business-dialog') {
  renderSurface(<BusinessMessageSurface />)
} else if (surface === 'close-recovery') {
  renderSurface(<CloseRecoverySurface />)
} else if (surface === 'mermaid-viewer') {
  renderSurface(<TooltipProvider><MermaidViewerSurface /></TooltipProvider>)
} else if (surface === 'runtime-installer') {
  renderSurface(<RuntimeInstallerSurface />)
} else if (surface === 'screen-translation') {
  renderSurface(<ScreenTranslationSurface />)
} else if (surface === 'screenshot-translation') {
  renderSurface(<TooltipProvider><ScreenshotTranslationWindow sessionId={screenshotSessionId} /></TooltipProvider>)
} else if (surface === 'screenshot-selection') {
  renderSurface(<ScreenshotSelectionSurface sessionId={screenshotSessionId} displayId={screenshotDisplayId} />)
} else if (surface === 'print') {
  renderSurface(<PrintDocumentSurface token={printToken} />)
} else {
  renderSurface(<StrictMode>
    {surface === 'sticky-note-context-menu'
      ? (
          <TooltipProvider>
            <ExternalContextMenuSurface />
          </TooltipProvider>
        )
      : surface === 'arknote-box'
      ? (
          <TooltipProvider>
            <BusinessDialogProvider>
              <ContextMenuProvider>
                <ArknoteBoxWindowRoot />
              </ContextMenuProvider>
            </BusinessDialogProvider>
          </TooltipProvider>
        )
      : surface === 'arknote-settings'
        ? <ArknoteSettingsPage />
      : backgroundSettingsRoute
        ? <BackgroundSettingsSurface route={backgroundSettingsRoute} />
      : stickyNoteRoute
      ? (
          <TooltipProvider>
            <BusinessDialogProvider>
              <StickyNoteWindowRoot noteId={stickyNoteRoute.noteId} />
            </BusinessDialogProvider>
          </TooltipProvider>
        )
      : (
          <TooltipProvider>
            <ContextMenuProvider>
              <App />
            </ContextMenuProvider>
          </TooltipProvider>
        )}
  </StrictMode>)
}

}
if ((!surface && !stickyNoteRoute && !backgroundSettingsRoute || surface === 'screenshot-translation') && window.arkdown?.getModelCapabilityRules) {
  const session = startModelRulesInitialization(window.arkdown)
  window.addEventListener('unload', session.dispose, { once: true })
}
renderRoot()

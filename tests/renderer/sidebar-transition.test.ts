import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const appCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)
const sidebarCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/editor/editor-right-sidebar.css'),
  'utf8',
)

it('shares the 240ms sidebar motion duration and easing with the left sidebar', () => {
  expect(appCss).toMatch(/--sidebar-motion-duration:\s*240ms;/)
  expect(appCss).toMatch(/--sidebar-motion-easing:\s*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\);/)
  expect(appCss).toMatch(
    /transition:\s*grid-template-columns\s+var\(--sidebar-motion-duration\)\s+var\(--sidebar-motion-easing\);/,
  )
  expect(sidebarCss).toMatch(
    /transition:\s*width\s+var\(--sidebar-motion-duration,\s*240ms\)\s+var\(--sidebar-motion-easing,\s*cubic-bezier\(\.2,\s*\.8,\s*\.2,\s*1\)\)/,
  )
})

it('clips sidebar content independently from its seven-pixel splitter hit layer', () => {
  expect(sidebarCss).toMatch(/\.editor-right-sidebar-motion-track\s*\{[^}]*overflow:\s*visible;/s)
  expect(sidebarCss).toMatch(/\.editor-right-sidebar-motion-clip\s*\{[^}]*overflow:\s*hidden;/s)
  expect(sidebarCss).toMatch(
    /\.editor-right-sidebar-motion-track:not\(\[data-phase="open"\]\)[^{]*\.editor-right-sidebar-splitter\s*\{[^}]*pointer-events:\s*none;/s,
  )
  expect(sidebarCss).toMatch(/\.editor-right-sidebar\s*\{[^}]*width:\s*var\(--editor-right-sidebar-width\);/s)
  expect(sidebarCss).toMatch(
    /\.editor-right-sidebar-motion-track\[data-resizing="true"\][^{]*\{[^}]*transition:\s*none;/s,
  )
})

it('removes right-sidebar transitions for reduced motion', () => {
  expect(sidebarCss).toMatch(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.editor-right-sidebar-motion-track[\s\S]*?transition:\s*none;/,
  )
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const stylesheetPath = resolve(
  process.cwd(),
  'src/renderer/editor/structured-blocks.css',
)

describe('structured editor block styles', () => {
  it('keeps the visual system scoped to Arkdown visual code blocks', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toContain('.visual-editor .milkdown .milkdown-code-block')
    expect(css).toContain('rgb(var(--theme-color-rgb, 198 40 40) / 5%)')
    expect(css).toContain('border-radius: 8px')
    expect(css).toContain('[data-arkdown-frontmatter="true"]')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).not.toMatch(/^\.cm-editor/m)
  })

  it('provides stable control, code, preview, and focus contracts', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toMatch(/\.copy-button[\s\S]*?inline-size:\s*32px/)
    expect(css).toMatch(/\.cm-content[\s\S]*?font-size:\s*14px/)
    expect(css).toContain('--arkdown-structured-block-default-text: #5f6368')
    expect(css).toContain('--arkdown-structured-block-default-text: #e0e0e1')
    expect(css).toMatch(/\.cm-content\s*\{[^}]*color:\s*var\(--arkdown-structured-block-default-text\)/s)
    expect(css).toMatch(/\.cm-activeLine[\s\S]*?--theme-color-rgb/)
    expect(css).toMatch(/\.preview-divider[\s\S]*?background:/)
    expect(css).toMatch(/:focus-visible[\s\S]*?55%/)
    expect(css).toMatch(/data-arkdown-frontmatter="true"[\s\S]*?YAML Front Matter/)
  })

  it('provides an accessible shared dark mode and redesigned language picker', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toMatch(/data-arkdown-color-mode="dark"[\s\S]*?#181818/i)
    expect(css).toMatch(/arkdown-block-theme-toggle[\s\S]*?inline-size:\s*32px/)
    expect(css).toMatch(/language-button[\s\S]*?border:\s*1px solid/)
    expect(css).toMatch(/language-list-item\[aria-selected='true'\]/)
    expect(css).toMatch(/data-arkdown-dark-token[\s\S]*?--arkdown-dark-token-color/)
  })

  it('styles the Mermaid conversion control consistently across themes and motion preferences', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toMatch(/arkdown-mermaid-convert-button[\s\S]*?inline-size:\s*32px/)
    expect(css).toMatch(/arkdown-mermaid-convert-button:hover/)
    expect(css).toMatch(/data-arkdown-color-mode="dark"[\s\S]*?arkdown-mermaid-convert-button:hover/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?arkdown-mermaid-convert-button/)
  })

  it('styles the code explanation control consistently with the shared code action cluster', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toMatch(/arkdown-code-explanation-button[\s\S]*?inline-size:\s*32px/)
    expect(css).toMatch(/arkdown-code-explanation-button svg[\s\S]*?stroke:\s*currentColor/)
    expect(css).toMatch(/arkdown-code-explanation-button:hover/)
    expect(css).toMatch(/data-arkdown-color-mode="dark"[\s\S]*?arkdown-code-explanation-button:hover/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?arkdown-code-explanation-button/)
  })

  it('limits the neutral base to the three approved controls', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toContain('color-mix(in srgb, #fff 95%, #000 5%)')
    const baseRule = css.match(/([^{}]+)\{[^{}]*background:\s*var\(--arkdown-structured-block-control\)/)
    expect(baseRule?.[1]).toContain('.language-button')
    expect(baseRule?.[1]).toContain('.arkdown-block-theme-toggle')
    expect(baseRule?.[1]).toContain('.copy-button')
    expect(baseRule?.[1]).not.toContain('.tools-button-group button')
    expect(baseRule?.[1]).not.toContain('.preview-toggle-button')
  })

  it('overrides the closed top controls with dark surfaces after the light neutral base', () => {
    const css = readFileSync(stylesheetPath, 'utf8')
    const lightOverrideIndex = css.indexOf(
      '.visual-editor .milkdown .milkdown-code-block:not([data-arkdown-frontmatter="true"])',
    )
    const darkOverride = css.match(
      /\.visual-editor \.milkdown \.milkdown-code-block\[data-arkdown-color-mode="dark"\]\s*\{([^}]*)\}/,
    )

    expect(lightOverrideIndex).toBeGreaterThan(-1)
    expect(darkOverride).not.toBeNull()
    expect(darkOverride?.index).toBeGreaterThan(lightOverrideIndex)
    expect(darkOverride?.[1]).toContain(
      '--arkdown-structured-block-control: #232628',
    )
    expect(darkOverride?.[1]).toContain(
      '--arkdown-structured-block-control-foreground: rgb(255 255 255 / 86%)',
    )
    expect(darkOverride?.[1]).toContain(
      '--arkdown-structured-block-border: rgb(255 255 255 / 13%)',
    )
    expect(css).toMatch(
      /data-arkdown-color-mode="dark"[\s\S]*?\.tools \.copy-button:hover[\s\S]*?background:\s*#292d2f/,
    )
    expect(css).toMatch(
      /data-arkdown-color-mode="dark"[\s\S]*?\.tools \.copy-button:active[\s\S]*?--theme-color-rgb/,
    )
    expect(css).toMatch(/button:focus-visible[\s\S]*?--theme-color-rgb/)
  })

  it('matches PreferencesSelect popup and scrollbar tokens without a search focus outline', () => {
    const css = readFileSync(stylesheetPath, 'utf8')

    expect(css).toMatch(/\.list-wrapper\s*\{[\s\S]*?padding:\s*5px[\s\S]*?border:\s*1px solid rgb\(0 0 0 \/ 9%\)[\s\S]*?border-radius:\s*8px[\s\S]*?background:\s*rgb\(255 255 255 \/ 98%\)[\s\S]*?0 10px 28px rgb\(0 0 0 \/ 16%\)/)
    expect(css).toMatch(/\.language-list-item\s*\{[\s\S]*?min-block-size:\s*32px[\s\S]*?border-radius:\s*5px/)
    expect(css).toMatch(/\.language-list::-webkit-scrollbar\s*\{[\s\S]*?width:\s*12px/)
    expect(css).toMatch(/\.search-box:has\(input:focus\)[\s\S]*?outline:\s*none[\s\S]*?box-shadow:\s*none/)
  })
})

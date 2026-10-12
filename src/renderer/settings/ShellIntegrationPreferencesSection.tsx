import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DefaultApplicationsSection } from './DefaultApplicationsSection'
import { EMPTY_SHELL_PREFERENCE_VIEW, type ShellIntegrationPreferenceDraft } from './shell-integration-preference-draft'

import { Choice, type ChoiceProps } from './ShellMenuChoice'

export function DesktopContextMenuCheckbox(props: Omit<ChoiceProps, 'label'>) {
  return <Choice {...props} label="在桌面右键菜单中增加“创建新便签”" />
}

const noSubscribe = () => () => {}
const noSnapshot = () => EMPTY_SHELL_PREFERENCE_VIEW

export function ShellIntegrationPreferencesSection({ desktopEnabled, onDesktopChange, draft }: {
  desktopEnabled: boolean
  onDesktopChange?(enabled: boolean): Promise<void>
  draft?: ShellIntegrationPreferenceDraft
}) {
  const { values: value, loaded, loading, pending, errors } = useSyncExternalStore(draft?.subscribe ?? noSubscribe, draft?.getSnapshot ?? noSnapshot)
  const [desktop, setDesktop] = useState(desktopEnabled)
  const [desktopPending, setDesktopPending] = useState(false)
  const [desktopError, setDesktopError] = useState<string>()
  const desktopLock = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (draft) void draft.refresh(window.arkdown)
    return () => { mounted.current = false }
  }, [draft])
  useEffect(() => { if (!desktopLock.current) setDesktop(desktopEnabled) }, [desktopEnabled])

  const changeDesktop = async (enabled: boolean) => {
    if (desktopLock.current) return
    desktopLock.current = true
    setDesktopPending(true); setDesktopError(undefined)
    try {
      if (!onDesktopChange) throw new Error('右键菜单设置不可用')
      await onDesktopChange(enabled)
      if (mounted.current) setDesktop(enabled)
    } catch (error) {
      if (mounted.current) setDesktopError(error instanceof Error ? error.message : '右键菜单设置失败，请重试。')
    } finally {
      desktopLock.current = false
      if (mounted.current) setDesktopPending(false)
    }
  }

  return <section aria-labelledby="preferences-context-menu-heading" className="preferences-section">
    <h2 id="preferences-context-menu-heading">右键菜单</h2>
    {errors.load && <p className="preferences-error" data-ui-selectable="true" role="alert" tabIndex={0}>{errors.load}</p>}
    {(errors.load || errors.documentOpenMenu || errors.markdownShellNew) && <button type="button" disabled={loading || Object.values(pending).some(Boolean)}
      onClick={() => void draft?.reload(window.arkdown)}>重新加载右键菜单设置</button>}
    <Choice label="md/txt文档上右键增加“使用Arkdown打开”"
      checked={value.documentOpenMenu} disabled={!loaded || loading || !window.arkdown?.updateShellIntegrationPreference}
      pending={pending.documentOpenMenu} error={errors.documentOpenMenu} onChange={(enabled) => void draft?.change('documentOpenMenu', enabled, window.arkdown)} />
    <DesktopContextMenuCheckbox checked={desktop} disabled={!onDesktopChange}
      pending={desktopPending} error={desktopError} onChange={(enabled) => void changeDesktop(enabled)} />
    <Choice label="在右键‘新建’菜单中增加 Markdown 文档"
      checked={value.markdownShellNew} disabled={!loaded || loading || !window.arkdown?.updateShellIntegrationPreference}
      pending={pending.markdownShellNew} error={errors.markdownShellNew} onChange={(enabled) => void draft?.change('markdownShellNew', enabled, window.arkdown)} />
    <DefaultApplicationsSection />
  </section>
}

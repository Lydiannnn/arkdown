import { useState } from 'react'
import {
  type BrowserSearchPreferences,
  type SearchProviderId,
  isSafeCustomSearchTemplate,
} from '../../shared/search-preferences'
import { PreferencesSelect } from './PreferencesSelect'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import './search-preferences.css'

interface SearchPreferencesDialogProps {
  initial: BrowserSearchPreferences
  onCancel(): void
  onSave(preferences: BrowserSearchPreferences): void
}

function templateError(provider: SearchProviderId, template: string): string | null {
  if (provider !== 'custom') return null
  if (!template.trim().startsWith('https://')) return '自定义搜索地址必须使用 HTTPS。'
  if ((template.match(/\{query\}/g) ?? []).length !== 1) {
    return '自定义搜索地址必须且只能包含一个 {query}。'
  }
  if (!isSafeCustomSearchTemplate(template)) return '自定义搜索地址无效。'
  return null
}

export function SearchPreferencesDialog({
  initial,
  onCancel,
  onSave,
}: SearchPreferencesDialogProps) {
  const [provider, setProvider] = useState<SearchProviderId>(initial.provider)
  const [customTemplate, setCustomTemplate] = useState(initial.customTemplate)
  const error = templateError(provider, customTemplate)

  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button onClick={() => requestClose(onCancel)} type="button">取消</button>
        <button
          className="arkdown-dialog__primary"
          disabled={Boolean(error)}
          onClick={() => requestClose(() => onSave({
            provider,
            customTemplate: provider === 'custom' ? customTemplate.trim() : '',
          }))}
          type="button"
        >
          保存
        </button>
      </>}
      className="preferences-dialog"
      onCancel={onCancel}
      title="浏览器搜索设置"
    >
        <div className="preferences-field preferences-search-provider">
          <span>搜索提供商</span>
          <PreferencesSelect<SearchProviderId>
            autoFocus
            label="搜索提供商"
            onChange={setProvider}
            options={[
              { value: 'bing', label: 'Bing' },
              { value: 'baidu', label: '百度（默认）' },
              { value: 'google', label: 'Google' },
              { value: 'custom', label: '自定义' },
            ]}
            value={provider}
          />
        </div>
        {provider === 'custom' && (
          <div className="preferences-field preferences-custom-search-field">
            <span>自定义搜索地址</span>
            <input
              aria-label="自定义搜索地址"
              aria-describedby={error ? 'search-dialog-help search-dialog-error' : 'search-dialog-help'}
              aria-invalid={Boolean(error)}
              onChange={(event) => setCustomTemplate(event.target.value)}
              placeholder="https://example.com/search?q={query}"
              spellCheck={false}
              value={customTemplate}
            />
            <small id="search-dialog-help">使用 <code>{'{query}'}</code> 表示搜索内容。</small>
            {error && <p className="preferences-error" id="search-dialog-error" data-ui-selectable="true" role="alert" tabIndex={0}>{error}</p>}
          </div>
        )}
    </ArkdownDialog>
  )
}

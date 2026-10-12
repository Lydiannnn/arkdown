import { useCallback, useEffect, useState } from 'react'
import {
  BACKGROUND_IMAGE_ALIGNMENTS,
  BACKGROUND_MASK_TYPES,
  type BackgroundImageAlignment,
  type BackgroundMaskType,
  type BackgroundSettings,
} from '../../shared/background-settings'
import { PreferencesRangeControl } from '../settings/PreferencesRangeControl'
import { AppIcon } from '../icons/AppIcon'
import { BackgroundImageLayer } from './BackgroundImageLayer'
import './background-settings-page.css'

export interface BackgroundSettingsPageProps {
  imageUrl: string | null
  onApply(settings: BackgroundSettings): void
  onCancel(): void
  onChooseImage(): void
  onPreview(settings: BackgroundSettings): void
  onRemoveImage(): void
  settings: BackgroundSettings
}

const maskLabels: Record<BackgroundMaskType, string> = {
  'diagonal-bottom-right': '右下对角',
  none: '无遮罩',
  circle: '圆形',
  'diagonal-top-left': '左上对角',
  'diagonal-top-right': '右上对角',
  'diagonal-bottom-left': '左下对角',
  'column-horizontal': '水平中央带',
  'column-vertical': '垂直中央带',
}

const alignmentLabels: Record<BackgroundImageAlignment, string> = {
  'right-bottom': '右下对齐',
  'left-top': '左上对齐',
  'right-top': '右上对齐',
  'left-bottom': '左下对齐',
  center: '居中对齐',
}

export function BackgroundSettingsPage({
  imageUrl,
  onApply,
  onCancel,
  onChooseImage,
  onPreview,
  onRemoveImage,
  settings,
}: BackgroundSettingsPageProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
        || event.keyCode === 229 || event.repeat
        || document.querySelector('[role="menu"], [role="listbox"], [role="dialog"][aria-modal="true"]')) return
      // Native select popups consume their own Escape before it reaches the window.
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onCancel])

  const [imageCoverage, setImageCoverage] = useState<'covered' | 'undersized'>('covered')
  const updatePreview = (change: Partial<BackgroundSettings>) => {
    onPreview({ ...settings, ...change })
  }
  const onImageCoverageChange = useCallback((coverage: 'covered' | 'undersized') => {
    setImageCoverage(coverage)
  }, [])
  const hasImage = imageUrl !== null
  const maskControlsDisabled = settings.maskType === 'none'

  return <main aria-label="背景设置" className="background-settings-page">
    <header className="background-settings-page__header">
      <h1>背景设置</h1>
      <button
        aria-label="关闭"
        className="background-settings-page__close"
        onClick={onCancel}
        type="button"
      >
        <AppIcon name="close" size={14} />
      </button>
    </header>

    <div className="background-settings-page__content">
      <section aria-labelledby="background-image-heading" className="background-settings-page__section">
        <h2 id="background-image-heading">背景图片</h2>
        <button
          aria-label={hasImage ? '更换背景图片' : '添加背景图片'}
          className="background-settings-page__preview"
          onClick={onChooseImage}
          type="button"
        >
          <BackgroundImageLayer
            anchor={settings.imageAlignment}
            imageUrl={imageUrl}
            onImageCoverageChange={onImageCoverageChange}
            settings={settings}
          />
          <div className="background-settings-page__preview-content" aria-hidden="true">
            <strong>背景预览</strong>
            <span>{hasImage ? '单击更换图片' : '单击添加图片'}</span>
          </div>
        </button>
        {hasImage && imageCoverage === 'undersized' && <p className="background-settings-page__warning" role="status">
          图片尺寸较小，放大窗口后可能出现未覆盖区域
        </p>}
        <div className="background-settings-page__image-actions">
          <button onClick={onChooseImage} type="button">{hasImage ? '更换图片' : '添加图片'}</button>
          <button disabled={!hasImage} onClick={onRemoveImage} type="button">移除背景</button>
        </div>
      </section>

      <section aria-labelledby="background-appearance-heading" className="background-settings-page__section">
        <h2 id="background-appearance-heading">显示效果</h2>
        <PreferencesRangeControl
          ariaLabel="图片不透明度"
          label="图片不透明度"
          max={100}
          min={0}
          onChange={(imageOpacityPercent) => updatePreview({ imageOpacityPercent })}
          suffix="%"
          value={settings.imageOpacityPercent}
        />
        <label className="background-settings-page__select-control">
          <span>图片对齐方式</span>
          <select
            aria-label="图片对齐方式"
            onChange={(event) => updatePreview({
              imageAlignment: event.target.value as BackgroundImageAlignment,
            })}
            value={settings.imageAlignment}
          >
            {BACKGROUND_IMAGE_ALIGNMENTS.map((alignment) => <option key={alignment} value={alignment}>
              {alignmentLabels[alignment]}
            </option>)}
          </select>
        </label>
        <label className="background-settings-page__select-control">
          <span>遮罩类型</span>
          <select
            aria-label="遮罩类型"
            onChange={(event) => updatePreview({ maskType: event.target.value as BackgroundMaskType })}
            value={settings.maskType}
          >
            {BACKGROUND_MASK_TYPES.map((maskType) => <option key={maskType} value={maskType}>
              {maskLabels[maskType]}
            </option>)}
          </select>
        </label>
        <fieldset disabled={maskControlsDisabled} className="background-settings-page__mask-ranges">
          <legend className="background-settings-page__sr-only">遮罩参数</legend>
          <PreferencesRangeControl
            ariaLabel="遮罩区域不透明度"
            label="遮罩区域不透明度"
            max={100}
            min={0}
            onChange={(maskOpacityPercent) => updatePreview({ maskOpacityPercent })}
            suffix="%"
            value={settings.maskOpacityPercent}
          />
          <PreferencesRangeControl
            ariaLabel="遮罩过渡速度"
            label="遮罩过渡速度"
            max={100}
            min={0}
            onChange={(maskTransitionPercent) => updatePreview({ maskTransitionPercent })}
            suffix="%"
            value={settings.maskTransitionPercent}
          />
          <PreferencesRangeControl
            ariaLabel="遮罩强度"
            label="遮罩强度"
            max={100}
            min={0}
            onChange={(maskStrengthPercent) => updatePreview({ maskStrengthPercent })}
            suffix="%"
            value={settings.maskStrengthPercent}
          />
        </fieldset>
        {maskControlsDisabled && <p className="background-settings-page__hint">
          选择遮罩类型后，可调整遮罩区域不透明度、过渡速度和白色区域强度。
        </p>}
      </section>
    </div>

    <footer className="background-settings-page__actions">
      <button onClick={onCancel} type="button">取消</button>
      <button className="background-settings-page__primary" onClick={() => onApply(settings)} type="button">应用</button>
    </footer>
  </main>
}

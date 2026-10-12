import './model-configuration-notice.css'

interface ModelConfigurationNoticeProps {
  onConfigure?(): void
  onDismiss(): void
  role: 'status' | 'alert'
}

export function ModelConfigurationNotice({ onConfigure, onDismiss, role }: ModelConfigurationNoticeProps) {
  return (
    <div className="model-configuration-notice">
      <div data-ui-selectable="true" role={role} tabIndex={0}>
        <h2>尚未配置大模型</h2>
        <p>请先配置大模型，再使用此功能。</p>
      </div>
      <div className="model-configuration-actions">
        <button className="model-configuration-primary" onClick={onConfigure} type="button">前往配置</button>
        <button onClick={onDismiss} type="button">暂不</button>
      </div>
    </div>
  )
}

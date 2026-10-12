import crosshair from '../../shared/screen-translation-crosshair.json'

// Phosphor Crosshair regular: both rings and four rounded cardinal strokes.
// Native rendering embeds this same geometry, dimensions and fixed red color.
export function ScreenTranslationCrosshair() {
  return <svg width={crosshair.sizeCss} height={crosshair.sizeCss} viewBox={`0 0 ${crosshair.viewBox} ${crosshair.viewBox}`}
    fill="none" stroke="currentColor" strokeWidth={crosshair.strokeWidth} strokeLinecap="round"
    style={{ color: crosshair.color }} aria-hidden="true">
    {crosshair.radii.map(radius => <circle key={radius} cx={crosshair.center} cy={crosshair.center} r={radius} />)}
    {crosshair.arms.map(([x1, y1, x2, y2], index) => <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} />)}
  </svg>
}

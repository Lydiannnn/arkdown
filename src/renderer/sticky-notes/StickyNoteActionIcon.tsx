export function StickyNoteActionIcon({ kind, size = 22, className = '' }: {
  kind: 'pin' | 'unpin' | 'archive' | 'trash'; size?: number; className?: string
}) {
  return <svg aria-hidden="true" focusable="false" className={`app-icon ${className}`} width={size} height={size}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'archive' ? <><rect x="3" y="4" width="18" height="4" rx="1.2" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6" /></>
      : kind === 'trash' ? <><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14M10 10v6m4-6v6" /></>
      : <g transform={kind === 'unpin' ? 'rotate(35 12 12)' : undefined}>
          <path d="M8 3h8l-1 7 3 4H6l3-4Z" fill={kind === 'pin' ? 'currentColor' : 'none'} />
          <path d="M12 14v7" />
        </g>}
  </svg>
}

/** Shared by the readonly preview and both main-editor modes. */
export function documentHeadingAnchor(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s+/gu, '-')
}

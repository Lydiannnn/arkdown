import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** A chooser default is a hint only; this never activates or grants a workspace. */
export async function workspacePickerDefaultPath(
  current: () => Promise<{ root: string }>,
  previous: () => string | null | Promise<string | null>,
): Promise<string | null> {
  try { return (await current()).root } catch { /* Fall back when the current activation no longer exists. */ }
  const candidate = await previous()
  if (!candidate || !path.isAbsolute(candidate)) return null
  try {
    const canonical = await realpath(candidate)
    return (await stat(canonical)).isDirectory() ? canonical : null
  } catch { return null }
}

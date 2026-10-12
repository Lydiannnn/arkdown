interface Breadcrumb {
  displayName: string
  absolutePath: string | null
}

/** Add only as many parent components as are needed to distinguish duplicate names. */
export function documentViewBreadcrumbLabels(entries: readonly Breadcrumb[]): string[] {
  const components = entries.map((entry) => entry.absolutePath?.split(/[\\/]/).filter(Boolean) ?? [entry.displayName])
  return entries.map((entry, index) => {
    const peers = entries.flatMap((other, otherIndex) => otherIndex !== index
      && other.displayName.toLocaleLowerCase('en-US') === entry.displayName.toLocaleLowerCase('en-US')
      ? [otherIndex] : [])
    if (!peers.length || !entry.absolutePath) return entry.displayName
    const segments = components[index]!
    for (let length = 2; length <= segments.length; length += 1) {
      const suffix = segments.slice(-length).join('\\')
      if (peers.every((peer) => components[peer]!.slice(-length).join('\\').toLocaleLowerCase('en-US') !== suffix.toLocaleLowerCase('en-US'))) return suffix
    }
    return entry.absolutePath
  })
}

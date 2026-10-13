import type { RuntimeComponentDefinition } from './runtime-component'

export type RuntimeComponentId = 'pandoc' | 'codex-cli' | 'ocr-base'
export type { RuntimeComponentDefinition } from './runtime-component'

export const RUNTIME_COMPONENT_DEFINITIONS: Readonly<Record<RuntimeComponentId, RuntimeComponentDefinition>> = {
  pandoc: {
    id: 'pandoc', label: '文档导入导出', entry: 'pandoc.exe',
    descriptor: { source: 'https', version: '3.10.1-r2', archiveName: 'arkdown-pandoc-3.10.1-r2-win-x64.tar.gz', bytes: 41_124_621,
      sha256: 'bcffd092628ba660766aa45cfde46041a15f34c408a1a9e660e5d187d3726849',
      url: 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/pandoc-3.10.1-r2-win-x64/arkdown-pandoc-3.10.1-r2-win-x64.tar.gz' },
    treeManifestSha256: '526dea6b7431aec7479f696a24ee0a0ac053f80610b4d436869282764a035ee5',
  },
  'codex-cli': {
    id: 'codex-cli', label: 'Codex CLI', entry: 'bin/codex.exe',
    descriptor: { source: 'https', version: '0.162.1', archiveName: 'arkdown-codex-cli-0.162.1-win-x64.tar.gz', bytes: 165_561_447,
      sha256: '687a4486ac386673440f77a68a68ec23430a8a44a55ed2fd2ffab40d3f3e1db3',
      url: 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/codex-cli-0.162.1-win-x64/arkdown-codex-cli-0.162.1-win-x64.tar.gz' },
    treeManifestSha256: '717c0db1cc94da352f3cc4ddb5ad3c98dc3eef268267bcf03aec458ac2ab0283',
  },
  'ocr-base': {
    id: 'ocr-base', label: '截图识别基础组件', entry: 'worker.js',
    descriptor: { source: 'https', version: '1.0.0', archiveName: 'arkdown-ocr-base-1.0.0-win-x64.tar.gz', bytes: 35_849_651,
      sha256: '0b9e75ddcfb7bf5465578f6e4fc99ffdcb6f13c9f1a8eaec9c688d5ba678d26f',
      url: 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/ocr-base-1.0.0-win-x64/arkdown-ocr-base-1.0.0-win-x64.tar.gz' },
    treeManifestSha256: '23d32aeadf23b12fdc2f267fc9bd45ef0b70cdd990585d2eff344c4d4731c985',
  },
}

/** Keep upgraded development/build inputs separate from previously frozen payloads. */
export function runtimeComponentSourceDirectory(id: string): string {
  return id === 'codex-cli' || id === 'pandoc' ? `${id}-${RUNTIME_COMPONENT_DEFINITIONS[id].descriptor.version}` : id
}

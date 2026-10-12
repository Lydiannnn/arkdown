import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractFile } from '@electron/asar'
import { auditPackagedApplication } from './audit-arkdown-package.ts'
import { readPackageProvenance } from './package-provenance.ts'
import { collectInstallerFiles, installerFileEntries, installerDefines, installerHash } from './windows-installer-input.ts'
import { uninstallAssociationInclude } from './build-uninstall-associations.ts'

const args = new Map<string,string>()
for (let i=2; i<process.argv.length; i+=2) {
  if (!process.argv[i]?.startsWith('--') || !process.argv[i+1]) throw new Error('Expected --package --edition --output --iscc')
  args.set(process.argv[i], process.argv[i+1])
}
function required(name: string) { const value=args.get(name); if (!value) throw new Error('Missing '+name); return value }
const root=path.resolve(required('--package')), output=path.resolve(required('--output')), iscc=path.resolve(required('--iscc'))
const repo=path.resolve(import.meta.dirname,'..'), edition=required('--edition')
const version=JSON.parse(extractFile(path.join(root,'resources/app.asar'),'package.json').toString('utf8')).version as string
const defines=installerDefines(version,edition)
const packagedEdition=JSON.parse(await readFile(path.join(root,'resources/package-edition.json'),'utf8')).edition
if (packagedEdition!==edition) throw new Error('Package edition mismatch')
const report=await auditPackagedApplication(root,{ workspaceCommitHelperArch: 'x64' })
if (report.findings.length) throw new Error('Package audit failed: '+report.findings.join('; '))
const provenance=await readPackageProvenance(root)
const files=await collectInstallerFiles(root)
const build=path.join(repo,'.superpowers/windows-installers/build',edition)
await mkdir(build,{recursive:true}); await mkdir(output,{recursive:true})
const fileList=path.join(build,'payload.iss')
await writeFile(fileList,installerFileEntries(root,files),'utf8')
const source=path.join(repo,'installer/windows/Arkdown.iss')
const installerSourceSha256=await installerHash(source)
const cleanup = await uninstallAssociationInclude(repo)
const cleanupInclude = path.join(build, 'uninstall-associations.iss')
await writeFile(cleanupInclude, cleanup.include, 'utf8')
const finalizationHelper = path.join(root, 'resources/application-updater/Arkdown.Update.exe')
const finalizationHelperSha256 = await installerHash(finalizationHelper)
const installedManifestSha256 = await installerHash(path.join(root, 'resources/update-managed-files.json'))
await new Promise<void>((resolve,reject)=>{
  const child=spawn(iscc,['/Qp','/DAppVersion='+version,'/DEdition='+defines.edition,'/DVersionMS='+defines.versionMS,
    '/DVersionLS='+defines.versionLS,'/DRepoRoot='+repo,'/DOutputDir='+output,'/DPayloadFileList='+fileList,
    '/DAssociationCleanupIncludeFile='+cleanupInclude,'/DInstallerFinalizeHelper='+finalizationHelper,
    '/DInstallerFinalizeHelperSha256='+finalizationHelperSha256,'/DInstalledManifestSha256='+installedManifestSha256,source],
  {cwd:repo,stdio:'inherit',windowsHide:true,shell:false})
  child.once('error',reject); child.once('exit',code=>code===0?resolve():reject(new Error('Inno compiler exit '+code)))
})
const executable=path.join(output,`Arkdown-${version}-${defines.edition}-Windows-x64-Setup.exe`)
if (await installerHash(source)!==installerSourceSha256) throw new Error('Installer source changed during compilation; rebuild required')
if ((await uninstallAssociationInclude(repo)).sha256!==cleanup.sha256) throw new Error('Association cleanup changed during compilation; rebuild required')
if (await installerHash(finalizationHelper)!==finalizationHelperSha256) throw new Error('Installer finalization helper changed during compilation; rebuild required')
if (await installerHash(path.join(root,'resources/update-managed-files.json'))!==installedManifestSha256) throw new Error('Installed manifest changed during compilation; rebuild required')
const record={version,edition,source:provenance,installerSourceSha256,associationCleanupSha256:cleanup.sha256,finalizationHelperSha256,installedManifestSha256,
  compiler:'Inno Setup 7.1.0',installer:path.basename(executable),sha256:await installerHash(executable),files}
await writeFile(path.join(output,`installer-${edition}-manifest.json`),JSON.stringify(record,null,2)+'\n','utf8')
console.log(JSON.stringify({installer:executable,sha256:record.sha256,files:files.length,sourceCommit:provenance.commit}))

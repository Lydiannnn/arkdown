import path from 'node:path'
import {cp,mkdir,readFile,writeFile,lstat} from 'node:fs/promises'

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {publishRuntimeComponent,componentTreeFiles} from './package-optional-components.ts'
const repo=path.resolve(import.meta.dirname,'..')
const prepared=path.join(repo,'.components/codex-0.162.1-preparation')
const source=path.join(prepared,'.components/codex-cli/runtime')
const runtime=path.join(repo,'.components/codex-cli-0.162.1/runtime')
const output=path.join(repo,'.components/public-codex-cli-0.162.1-release')
const upstreamFiles=JSON.parse(await readFile(path.join(prepared,'upstream-payload-inventory.json'),'utf8')).length
const sourceArchives=JSON.parse(await readFile(path.join(prepared,'source-plan.json'),'utf8')).count
if(await lstat(runtime).catch(()=>null))throw Error('Do not overwrite prepared versioned runtime')
await mkdir(path.dirname(runtime),{recursive:true});await cp(source,runtime,{recursive:true,errorOnExist:true,force:false})
if(JSON.stringify(await componentTreeFiles(runtime))!==JSON.stringify(await componentTreeFiles(source)))throw Error('Copied runtime mismatch')
await mkdir(output,{recursive:true})
for(const name of ['codex-0.162.1-source.tar.gz','codex-cli-0.162.1-third-party-sources.tar.gz','THIRD_PARTY_LICENSES.txt'])await cp(path.join(prepared,'.components/public-codex-cli-release',name),path.join(output,name),{force:false,errorOnExist:true})
const published=await publishRuntimeComponent({id:'codex-cli',version:'0.162.1',entry:'bin/codex.exe',runtimeRoot:runtime,outputRoot:output})
published.descriptor.url=`https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/codex-cli-0.162.1-win-x64/${published.descriptor.archiveName}`
await writeFile(path.join(output,'manifest.json'),JSON.stringify(published.descriptor,null,2)+'\n','utf8')
await writeFile(path.join(output,'README.md'),`# Codex CLI 0.162.1\n\nWindows x64 optional component for Arkdown standard edition. The runtime archive has no enclosing directory. Its exact size and SHA-256 are in manifest.json. Arkdown pins the raw component-manifest.json SHA-256 and verifies every regular payload file before use.\n\nRaw tree manifest SHA-256: \`${published.treeManifestSha256}\`\n\nContains all ${upstreamFiles} unchanged files from the official OpenAI rust-v0.162.1 Windows x64 package: Codex, code mode host, command runner, Windows sandbox setup, ripgrep 15.2.0 package metadata and native voice runtime with upstream notices. Entry: bin/codex.exe. OpenAI LICENSE/NOTICE and complete collected dependency notices are included under licenses/. Authentication occurs separately on the user's computer.\n\nThe codex-cli-0.162.1-third-party-sources.tar.gz companion contains actual upstream Codex source with Cargo.lock and build scripts, plus ${sourceArchives} source archives covering the Codex and ripgrep lockfiles, ripgrep 15.2.0 source and pinned native voice dependencies. Registry crates are verified against Cargo.lock checksums; Git sources use fixed commits. The source-inventory.json inside records URLs, sizes and SHA-256. The official ripgrep Windows package was hash-verified and its executable matched byte-for-byte. Its complete license texts are included.\n\nUpstream package: https://github.com/openai/codex/releases/tag/rust-v0.162.1\n\nNo Arkdown application source, user documents, credentials, authentication tokens or settings are included. Third-party licenses and warranty disclaimers apply.\n`,'utf8')
const isolated=path.join(prepared,'version-only-profile');await mkdir(isolated,{recursive:true})
const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PATH:process.env.PATH,TEMP:isolated,TMP:isolated,USERPROFILE:isolated,APPDATA:isolated,LOCALAPPDATA:isolated,CODEX_HOME:isolated}
const version=await promisify(execFile)(path.join(runtime,'bin/codex.exe'),['--version'],{cwd:isolated,env,windowsHide:true,shell:false,timeout:20000,encoding:'utf8'})
if(version.stdout.trim()!=='codex-cli 0.162.1')throw Error('CLI version mismatch')
const report={...published,versionStdout:version.stdout.trim(),userAccountAccessed:false,upstreamFilesPreserved:upstreamFiles,sourceArchives}
await writeFile(path.join(prepared,'preparation-result.json'),JSON.stringify(report,null,2)+'\n','utf8')
console.log(JSON.stringify(report,null,2))

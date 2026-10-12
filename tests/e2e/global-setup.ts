import {
  flipFuses,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertPackageProvenanceMatchesCleanSource } from '../../scripts/package-provenance'
import {
  cleanupRuntime,
  prepareSharedRuntime,
  runE2eStage,
} from './support/runtime'

const PACKAGED_APPLICATION = process.env.ARKDOWN_E2E_PACKAGED_APPLICATION
  ? path.resolve(process.env.ARKDOWN_E2E_PACKAGED_APPLICATION)
  : path.resolve('out/Arkdown-win32-x64')
const PACKAGED_EXECUTABLES = ['Arkdown.exe', 'Arknote.exe'] as const
const PACKAGED_ARCH = process.env.ARKDOWN_E2E_PACKAGE_ARCH === 'arm64' ? 'arm64' : 'x64'
const execFileAsync = promisify(execFile)
// Playwright loads this setup through its CJS transform. Audit modules use import.meta
// and native .ts ESM imports, so evaluate them in an untransformed Node subprocess.
// Paths are argv values, never interpolated into this fixed program or a shell.
const PACKAGE_AUDIT_PROGRAM = `
import { auditPackagedApplication } from './scripts/audit-arkdown-package.ts';
const [root, screenshotBridgeSourceDirectory, workspaceCommitHelperArch] = process.argv.slice(1);
if (workspaceCommitHelperArch !== 'x64' && workspaceCommitHelperArch !== 'arm64') {
  throw new Error('Package audit requires an explicit target architecture');
}
const report = await auditPackagedApplication(root, {
  screenshotBridgeSourceDirectory,
  workspaceCommitHelperArch,
});
if (report.findings.length > 0) throw new Error('Formal package audit failed: ' + report.findings.join('; '));
process.stdout.write(JSON.stringify({ version: report.version, executables: report.executables }));
`

export async function auditE2ePackagedApplication(
  packagedApplication: string,
  sourceRoot: string,
  arch: 'x64' | 'arm64',
): Promise<void> {
  await execFileAsync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--input-type=module',
    '--eval', PACKAGE_AUDIT_PROGRAM,
    path.resolve(packagedApplication), path.resolve(sourceRoot, 'scripts'), arch,
  ], {
    cwd: path.resolve(sourceRoot),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}
const FUSE_DISABLED = '0'.charCodeAt(0)
const FUSE_ENABLED = '1'.charCodeAt(0)
const FORMAL_FUSES = new Map<FuseV1Options, number>([
  [FuseV1Options.RunAsNode, FUSE_DISABLED],
  [FuseV1Options.EnableCookieEncryption, FUSE_ENABLED],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FUSE_DISABLED],
  [FuseV1Options.EnableNodeCliInspectArguments, FUSE_DISABLED],
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FUSE_ENABLED],
  [FuseV1Options.OnlyLoadAppFromAsar, FUSE_ENABLED],
])

async function assertFuses(
  executable: string,
  expectedFuses: ReadonlyMap<FuseV1Options, number>,
  label: string,
): Promise<void> {
  const wires = await getCurrentFuseWire(executable)
  for (const [fuse, expected] of expectedFuses) {
    const actual = wires[fuse]
    if (actual !== expected) {
      throw new Error(
        `${label} Electron Fuse ${FuseV1Options[fuse]} is ${String(actual)}; expected ${String(expected)}`,
      )
    }
  }
}

async function assertPackagedFuses(label: string): Promise<void> {
  for (const executableName of PACKAGED_EXECUTABLES) {
    await assertFuses(
      path.join(PACKAGED_APPLICATION, executableName),
      FORMAL_FUSES,
      `${label} ${executableName}`,
    )
  }
}

async function packagedExecutableHashes(): Promise<Map<string, string>> {
  return new Map(await Promise.all(PACKAGED_EXECUTABLES.map(async (executableName) => {
    const bytes = await readFile(path.join(PACKAGED_APPLICATION, executableName))
    return [executableName, createHash('sha256').update(bytes).digest('hex')] as const
  })))
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await assertPackageProvenanceMatchesCleanSource(PACKAGED_APPLICATION, path.resolve('.'))
  await runE2eStage('审核正式包内容与截图桥接脚本', async () => {
    await auditE2ePackagedApplication(PACKAGED_APPLICATION, path.resolve('.'), PACKAGED_ARCH)
  })
  await runE2eStage('检查正式双 EXE Fuse', async () => {
    await assertPackagedFuses('Formal packaged')
  })
  const formalHashes = await packagedExecutableHashes()

  const shared = await prepareSharedRuntime({
    executableName: 'Arkdown.exe',
    additionalExecutableNames: ['Arknote.exe'],
    packagedApplication: PACKAGED_APPLICATION,
    instrumentExecutable: async (executable) => {
      await flipFuses(executable, {
        version: FuseVersion.V1,
        [FuseV1Options.EnableNodeCliInspectArguments]: true,
      })
      await assertFuses(executable, new Map([
        ...FORMAL_FUSES,
        [FuseV1Options.EnableNodeCliInspectArguments, FUSE_ENABLED],
      ]), 'Shared E2E runtime')
    },
  })

  try {
    await runE2eStage('复核正式双 EXE Fuse', async () => {
      await assertPackagedFuses('Formal packaged')
      const afterHashes = await packagedExecutableHashes()
      for (const [executableName, expectedHash] of formalHashes) {
        if (afterHashes.get(executableName) !== expectedHash) {
          throw new Error(`Formal packaged ${executableName} changed while preparing E2E copies`)
        }
      }
    })
    process.env.ARKDOWN_E2E_SHARED_APPLICATION = shared.application
  } catch (error) {
    await cleanupRuntime(shared.root)
    throw error
  }

  return async () => {
    delete process.env.ARKDOWN_E2E_SHARED_APPLICATION
    await runE2eStage('清理共享运行文件', async () => {
      await cleanupRuntime(shared.root)
    })
  }
}

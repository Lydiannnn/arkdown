import { defineConfig } from 'vite'
import { APPLICATION_UPDATER_TRUST_ENV } from './scripts/build-application-updater.ts'
import { parseApplicationUpdaterTrust } from './src/main/updates/update-helper.ts'
import {
  parseWorkspaceCommitHelperTrustEnvironment,
  WORKSPACE_COMMIT_HELPER_TRUST_ENV,
} from './scripts/build-workspace-commit-helper.ts'

export default defineConfig(() => {
  const serializedTrust = process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV]
  const packagedTrust = serializedTrust === undefined
    ? null
    : parseWorkspaceCommitHelperTrustEnvironment(serializedTrust)
  return {
    define: {
      __ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__: JSON.stringify(packagedTrust),
      __ARKDOWN_APPLICATION_UPDATER_TRUST__: JSON.stringify(process.env[APPLICATION_UPDATER_TRUST_ENV] ? parseApplicationUpdaterTrust(JSON.parse(process.env[APPLICATION_UPDATER_TRUST_ENV]!)) : null),
    },
    build: {
      rollupOptions: {
        external: ['electron'],
        output: {
          // Preserve the source attribution through production minification.
          comments: { legal: true },
        },
      },
    },
  }
})

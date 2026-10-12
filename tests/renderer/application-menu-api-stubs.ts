import type { ArkdownApi } from '../../src/shared/contracts'

type ApplicationMenuApiKey =
  | 'recordRecentDocument'
  | 'updateApplicationMenuWindowState'
  | 'onApplicationMenuChanged'
  | 'printDocument'
  | 'takePrintDocument'
  | 'readyPrintDocument'
  | 'onWindowStateChanged'

export const applicationMenuApiStubs = {
  recordRecentDocument: async (absolutePath: string) => ({
    ok: true as const,
    value: [absolutePath],
  }),
  updateApplicationMenuWindowState: async () => ({
    ok: true as const,
    value: undefined,
  }),
  onApplicationMenuChanged: () => () => undefined,
  onWindowStateChanged: () => () => undefined,
  printDocument: async () => ({ ok: true as const, value: null }),
  takePrintDocument: async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED' as const, message: 'Print surface unavailable' },
  }),
  readyPrintDocument: async () => ({ ok: true as const, value: null }),
} satisfies Pick<ArkdownApi, ApplicationMenuApiKey>

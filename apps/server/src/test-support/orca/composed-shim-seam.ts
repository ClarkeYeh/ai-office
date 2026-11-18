import type { StartOptions } from '../../main.js';

/**
 * The single seam onto M2-T10's follow-up dev-only shim-folder option. Until it
 * merges, `startServer` ignores this key and the composed scenario fails closed
 * (no shim is reported, so the harness intent stays pending). When T10 lands,
 * align the name and shape here only; nothing else names the option.
 *
 * Expected contract (`--dev --runtime orca` only, programmatic like `testOnly.scm`):
 * - `folder`: absolute, already registered folder workspace used for the shim
 *   instead of `<dataDir>/orca-home`; the backend never registers it.
 * - `onShimCreated(handle)`: awaited after each shim `terminal create` receipt,
 *   before the handle is used, so the harness ledger is persisted first.
 * - `onRunCreated(runId)`: awaited after each `run-create` receipt.
 */
export const COMPOSED_SHIM_OPTION = 'orcaShim';

export interface ComposedShimSeam {
  folder: string;
  onShimCreated(handle: string): Promise<void>;
  onRunCreated(runId: string): Promise<void>;
}

export function composedShimOptions(
  seam: ComposedShimSeam,
): Pick<StartOptions, 'testOnly'> {
  return {
    testOnly: {
      [COMPOSED_SHIM_OPTION]: seam,
    } as unknown as NonNullable<StartOptions['testOnly']>,
  };
}

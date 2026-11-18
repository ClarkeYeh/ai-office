import type { StartOptions } from '../../main.js';

/**
 * The single seam onto M2-T10's dev-only shim-folder option (runtime-orca
 * SLEEP_WAKE.md "Isolated composed dev smoke"): `orcaHome` selects the already
 * registered, owner-approved folder (verified with `repo list`, never registered),
 * and `testOnly.onShimCreated` is awaited after each new shim's creation receipt,
 * so the harness ledger is persisted before further startup work.
 */
export interface ComposedShimSeam {
  orcaHome: string;
  onShimCreated(handle: string): Promise<void>;
}

export function composedShimOptions(
  seam: ComposedShimSeam,
): Pick<StartOptions, 'orcaHome' | 'testOnly'> {
  return {
    orcaHome: seam.orcaHome,
    testOnly: { onShimCreated: seam.onShimCreated },
  };
}

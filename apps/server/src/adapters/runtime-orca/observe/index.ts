import type { RuntimePort } from '../../../ports/runtime.js';
/** T6 supplies observe and its cursor payload; T3 supplies the versioned codec. */
export type OrcaObserver = Pick<RuntimePort, 'observe'>;

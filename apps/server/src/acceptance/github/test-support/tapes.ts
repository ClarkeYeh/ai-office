import { fileURLToPath } from 'node:url';
import type { StepResult, semantics } from './scenario.js';

const directory = fileURLToPath(
  new URL(
    '../../../../../../fixtures/github/2022-11-28/acceptance/',
    import.meta.url,
  ),
);
/** The live run's sanitized event semantics, asserted by the CI replay. */
export const liveTracePath = `${directory}t15-mainline.trace.json`;
/** The live run's sanitized HTTP recording (T7 format), kept as evidence. */
export const liveHttpPath = `${directory}t15-mainline.http.json`;
/** The step 12 live fault run's sanitized HTTP recording. */
export const faultHttpPath = `${directory}t15-faults.http.json`;

export interface LiveTrace {
  format: 1;
  source: 'live';
  steps: StepResult[];
  semantics: ReturnType<typeof semantics>;
}

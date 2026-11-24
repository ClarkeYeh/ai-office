import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(
  new URL('../../../../../../fixtures/github/2022-11-28/', import.meta.url),
);
/** The live run's segment-1 event semantics, asserted by the CI twin. */
export const rehearsalTracePath = `${directory}m5-rehearsal.trace.json`;
/** The live run's sanitized segment-1 HTTP recording (evidence only). */
export const rehearsalHttpPath = `${directory}m5-rehearsal.http.json`;

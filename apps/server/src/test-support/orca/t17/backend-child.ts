/**
 * M2-T17 child backend: `--dev --runtime orca` in its own process so the
 * acceptance can `kill -9` it and restart on the same AI_OFFICE_HOME. Started
 * only by `backend-process.ts` with a minimal environment and an IPC channel.
 * Each new shim is reported to the parent, which ledgers it before the ack.
 */
import { join } from 'node:path';
import { startServer } from '../../../main.js';
import { composedShimOptions } from '../composed-shim-seam.js';

type ToParent =
  | { type: 'shim'; handle: string }
  | { type: 'ready'; url: string; bootstrapUrl: string; pid: number }
  | { type: 'failed'; message: string };

const send = (message: ToParent) => process.send?.(message);
const home = process.env.AI_OFFICE_HOME;
const orcaHome = process.env.AIO_T17_ORCA_HOME;
if (!process.send || !home || !orcaHome)
  throw new Error(
    'T17 child backend requires IPC, AI_OFFICE_HOME and AIO_T17_ORCA_HOME',
  );

let acked: (() => void) | undefined;
process.on('message', (message: { type?: string }) => {
  if (message.type === 'shim-ack') acked?.();
});

try {
  const server = await startServer({
    dev: true,
    runtime: 'orca',
    port: 0,
    env: process.env,
    webDist: join(home, 'no-web'),
    print: () => undefined,
    ...(process.env.AIO_T17_CLI_PATH
      ? { cliPath: process.env.AIO_T17_CLI_PATH }
      : {}),
    ...composedShimOptions({
      orcaHome,
      onShimCreated: (handle) =>
        new Promise<void>((resolve) => {
          acked = resolve;
          send({ type: 'shim', handle });
        }),
    }),
  });
  process.once('SIGTERM', () => {
    void server.close().finally(() => process.exit(0));
  });
  send({
    type: 'ready',
    url: server.url,
    bootstrapUrl: server.bootstrapUrl,
    pid: process.pid,
  });
} catch (error) {
  // The class name only: startup errors never carry argv or environment.
  send({
    type: 'failed',
    message:
      error instanceof Error
        ? error.constructor.name + ': ' + error.message
        : 'unknown',
  });
  process.exit(1);
}

/**
 * M5-T7 dev backend child for the T11b preview: `--dev --runtime orca` with
 * the SCM bridged to the harness process (`scm-bridge.ts`), so the harness
 * can `kill -9` this process and restart it on the same home and port while
 * the scm-gitremote stand-in keeps its state. Started only by
 * `backend-process.ts` (minimal environment, IPC with `advanced`
 * serialization); speaks the same `shim` / `ready` / `failed` protocol as
 * the M2-T17 child.
 */
import { join } from 'node:path';
import { startServer } from '../../main.js';
import { composedShimOptions } from '../orca/composed-shim-seam.js';
import { remoteScm, type ScmCall } from './scm-bridge.js';

type ToParent =
  | { type: 'shim'; handle: string }
  | { type: 'ready'; url: string; bootstrapUrl: string; pid: number }
  | { type: 'failed'; message: string };

const send = (message: ToParent | ScmCall) => process.send?.(message);
const home = process.env.AI_OFFICE_HOME;
const orcaHome = process.env.AIO_T17_ORCA_HOME;
const port = Number(process.env.AIO_JOINT_PORT ?? '0');
if (!process.send || !home || !orcaHome || !Number.isSafeInteger(port))
  throw new Error(
    'Joint child backend requires IPC, AI_OFFICE_HOME and AIO_T17_ORCA_HOME',
  );

let acked: (() => void) | undefined;
process.on('message', (message: { type?: string }) => {
  if (message.type === 'shim-ack') acked?.();
});

try {
  const { testOnly, ...seam } = composedShimOptions({
    orcaHome,
    onShimCreated: (handle) =>
      new Promise<void>((resolve) => {
        acked = resolve;
        send({ type: 'shim', handle });
      }),
  });
  const server = await startServer({
    dev: true,
    runtime: 'orca',
    port,
    env: process.env,
    webDist: join(home, 'no-web'),
    print: () => undefined,
    ...seam,
    testOnly: { ...testOnly, scm: remoteScm(process as never) },
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

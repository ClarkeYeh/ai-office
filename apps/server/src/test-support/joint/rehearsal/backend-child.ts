/**
 * M5-T11 rehearsal backend child (M5_PLAN §2.4): `--dev --fake m5-mainline`
 * with `testOnly.scm` bridged to the harness process (`scm-bridge.ts`), where
 * the real scm-github (live) or scm-fake (CI twin) runs, so this process never
 * holds a token. The fake world checkpoints to the home (`persistFakeWorld`)
 * and survives the `kill -9`. Started only by `backend-process.ts` (minimal
 * environment, IPC with `advanced` serialization); speaks its `ready` /
 * `failed` protocol. Test-support entry only: production never sets testOnly.
 *
 * Pause points are exact because the harness withholds the bridge reply of the
 * succeeded `createIssue` / `mergePR`: this process can never record
 * `command.succeeded` for it. On `freeze` it flushes the fake world, writes the
 * frozen marker and blocks its event loop until the SIGKILL arrives, so nothing
 * changes between the checkpoint and the kill.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../../../main.js';
import type { ScmPort } from '../../../ports/scm.js';
import { remoteScm, type ScmCall } from '../scm-bridge.js';
import { REHEARSAL_REPO, frozenMarker, type WorldPush } from './protocol.js';

type ToParent =
  | { type: 'ready'; url: string; bootstrapUrl: string; pid: number }
  | { type: 'failed'; message: string };

const send = (message: ToParent | ScmCall) => process.send?.(message);
const home = process.env.AI_OFFICE_HOME;
const port = Number(process.env.AIO_JOINT_PORT ?? '0');
const shortId = process.env.AIO_REHEARSAL_SHORT_ID;
if (!process.send || !home || !shortId || !Number.isSafeInteger(port))
  throw new Error(
    'Rehearsal child requires IPC, AI_OFFICE_HOME and AIO_REHEARSAL_SHORT_ID',
  );

const remote = remoteScm(process as never) as ScmPort & WorldPush;
const repo = REHEARSAL_REPO.github;

try {
  const server = await startServer({
    dev: true,
    fake: 'm5-mainline',
    port,
    env: process.env,
    webDist: join(home, 'no-web'),
    print: () => undefined,
    testOnly: {
      scm: remote,
      shortId,
      fakeRepo: REHEARSAL_REPO,
      persistFakeWorld: true,
      fakeRuntime: {
        onPush: (request) => remote.worldPush(request),
        remoteHead: async (ref) =>
          (await remote.compareBranch(repo, ref, ref))?.headSha ?? null,
        refreshHeadAfterPush: true,
      },
    },
  });
  process.on('message', (message: { type?: string; window?: string }) => {
    if (message.type !== 'freeze' || typeof message.window !== 'string')
      return;
    server.checkpointFakeWorld?.();
    writeFileSync(frozenMarker(home, message.window), `${process.pid}\n`, {
      mode: 0o600,
    });
    // Block until SIGKILL: no timer, I/O or submission runs after the flush.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
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

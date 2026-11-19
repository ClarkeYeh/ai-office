import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** A launcher-owned session leaves the browser's one-time bootstrap code untouched.
 * This opens only the fresh home allocated by devOffice, and never reads user sessions.
 * All controls still go through the normal authenticated HTTP routes.
 * @param {string} home @param {string} url
 */
export async function launcherSession(home, url) {
  const { openSqliteStores } =
    await import('../../apps/server/dist/adapters/store-sqlite/index.js');
  const stores = openSqliteStores({
    filename: join(home, 'data/ai-office.sqlite'),
    clock: { now: () => new Date() },
    ids: {
      ulid: () => {
        throw new Error('Session helper must never write events');
      },
    },
    projectionVersion: 1,
  });
  let code;
  try {
    code = stores.sessions.issueBootstrapCode();
  } finally {
    stores.close();
  }
  const response = await globalThis.fetch(
    `${url}/auth/bootstrap?code=${encodeURIComponent(code)}`,
    { redirect: 'manual' },
  );
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (response.status !== 302 || !cookie)
    throw new Error('Launcher authentication failed');
  return cookie;
}

/** @param {string} url @param {string} cookie @param {number} seconds @param {AbortSignal} signal */
export async function autoMergeFinal(url, cookie, seconds, signal) {
  const opened = new Map();
  while (!signal.aborted) {
    const response = await globalThis.fetch(`${url}/api/v1/gates?status=open`, {
      headers: { cookie },
      signal,
    });
    if (!response.ok)
      throw new Error(`Cannot read final gates: ${response.status}`);
    const { gates } =
      /** @type {{gates:Array<{gateId:string, workflowId:string, version:number, stageKind:string, status:string}>}} */ (
        await response.json()
      );
    const live = new Set();
    for (const gate of gates) {
      if (gate.stageKind !== 'final-pr' || gate.status !== 'open') continue;
      const key = `${gate.gateId}:${gate.version}`;
      live.add(key);
      if (!opened.has(key)) opened.set(key, Date.now());
      if (Date.now() - opened.get(key) < seconds * 1000) continue;
      const snapshot = await globalThis.fetch(
        `${url}/api/v1/workflows/${encodeURIComponent(gate.workflowId)}`,
        { headers: { cookie }, signal },
      );
      if (!snapshot.ok) throw new Error('Cannot read final PR');
      const { readModel } =
        /** @type {{readModel:{gates:Array<{gateId:string, pr?:{number:number}}>}}} */ (
          await snapshot.json()
        );
      const number = readModel.gates.find(
        (/** @type {{gateId:string}} */ entry) => entry.gateId === gate.gateId,
      )?.pr?.number;
      if (typeof number !== 'number')
        throw new Error('Final PR number missing');
      const merged = await globalThis.fetch(
        `${url}/dev/fake/scm/merge-final-pr`,
        {
          method: 'POST',
          headers: { cookie, origin: url, 'content-type': 'application/json' },
          body: JSON.stringify({ number }),
          signal,
        },
      );
      if (!merged.ok) throw new Error(`Final merge failed: ${merged.status}`);
    }
    for (const key of opened.keys()) if (!live.has(key)) opened.delete(key);
    await delay(500, undefined, { signal });
  }
}

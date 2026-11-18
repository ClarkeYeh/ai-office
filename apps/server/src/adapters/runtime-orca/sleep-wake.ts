import { spawn } from 'node:child_process';
import { PortError } from '../../ports/errors.js';
import type { RuntimePort } from '../../ports/runtime.js';
import type { SessionRef } from '../../ports/refs.js';
import type { Logger } from '../../ports/services.js';
import { OrcaObserver, type OrcaObserverOptions } from './observe/index.js';

export interface SleepAssertion {
  kill(): unknown;
  once(event: 'error' | 'exit', listener: () => void): unknown;
}
export interface SleepWakeOptions {
  observer: OrcaObserverOptions;
  version: { check(force?: boolean): Promise<unknown> };
  preventSleep?: boolean;
  platform?: string;
  pid?: number;
  spawn?: (file: string, args: string[]) => SleepAssertion;
  logger: Logger;
}

/** T10 composes this decorator around createOrcaRuntime, and connects
 * forceRecheck to HealthMonitor. Observation stays on the caller's durable
 * cursor; rechecking never consumes events outside the normal ingest path.
 */
export function withSleepWake(runtime: RuntimePort, options: SleepWakeOptions) {
  const sessions = new Set<SessionRef>();
  let observer = new OrcaObserver(options.observer);
  let assertion: SleepAssertion | undefined;
  let stopped = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const release = () => {
    const child = assertion;
    assertion = undefined;
    child?.kill();
  };
  const hold = () => {
    if (
      stopped ||
      assertion ||
      !sessions.size ||
      !(options.preventSleep ?? true) ||
      (options.platform ?? process.platform) !== 'darwin'
    )
      return;
    try {
      const child = (
        options.spawn ??
        ((file, args) => spawn(file, args, { stdio: 'ignore' }))
      )('/usr/bin/caffeinate', [
        '-i',
        '-w',
        String(options.pid ?? process.pid),
      ]);
      assertion = child;
      const ended = () => {
        if (assertion === child) assertion = undefined;
      };
      child.once('exit', ended);
      child.once('error', () => {
        ended();
        options.logger.warn({ code: 'sleep_prevention_unavailable' });
      });
    } catch {
      options.logger.warn({ code: 'sleep_prevention_unavailable' });
    }
  };
  let draining: Promise<void> = Promise.resolve();
  const stopObservation = () => {
    stopped = true;
    draining = observer.closeAndDrain();
    sessions.clear();
    release();
  };
  return {
    ...runtime,
    async answer(...args: Parameters<RuntimePort['answer']>) {
      await runtime.answer(...args);
      observer.markAnswered(args[0]);
    },
    stopObservation,
    async openSession(req: Parameters<RuntimePort['openSession']>[0]) {
      const session = await runtime.openSession(req);
      sessions.add(session);
      hold();
      return session;
    },
    async closeSession(session: SessionRef) {
      await runtime.closeSession(session);
      sessions.delete(session);
      if (!sessions.size) release();
    },
    observe: (...args: Parameters<RuntimePort['observe']>) =>
      serial(async () => {
        if (stopped)
          throw new PortError(
            'guard',
            'runtime_closed',
            'Runtime observation stopped',
          );
        sessions.add(args[0]); // recovered workflows also hold the assertion
        hold();
        return observer.observe(...args);
      }),
    forceRecheck: () =>
      serial(async () => {
        if (stopped) return;
        // Drop volatile poll/throttle state, not the caller's committed cursor.
        // The next observe performs full worker-list and inbox backfill even if
        // the previous batch was not committed. No spawn/send operation occurs.
        await observer.closeAndDrain();
        if (stopped) return;
        observer = new OrcaObserver(options.observer);
        await options.observer.identity.ensure({ force: true });
        for (const session of sessions)
          await options.observer.identity.checkOwnership(session, {
            force: true,
          });
        await options.version.check(true);
      }),
    /** T10 calls after observation stops and before backend shutdown. */
    close: () => {
      // Abort polls immediately, even when an observe/recheck is waiting on CLI IO.
      stopObservation();
      return serial(async () => {
        await draining;
      });
    },
  };
}

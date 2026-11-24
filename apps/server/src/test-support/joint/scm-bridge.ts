/**
 * M5-T7 SCM over IPC for the T11b preview (`--dev --runtime orca` +
 * scm-gitremote). The stand-in keeps its GitHub objects in memory, so it
 * lives in the harness process and the killable backend child reaches it
 * through this bridge: a `kill -9` loses the child's in-flight calls but not
 * the stand-in's state — like real GitHub, a merge that completed while the
 * backend died stays merged and the restarted backend must reconcile it.
 */
import { PortError } from '../../ports/errors.js';
import type { ScmPort } from '../../ports/scm.js';

export interface ScmCall {
  type: 'scm-call';
  id: number;
  method: string;
  args: unknown[];
}
export type ScmResult =
  | { type: 'scm-result'; id: number; ok: true; value: unknown }
  | {
      type: 'scm-result';
      id: number;
      ok: false;
      error: {
        portError: boolean;
        category?: string;
        code?: string;
        message: string;
        retryable?: boolean;
        retryAfterMs?: number;
      };
    };

interface Channel {
  send(message: ScmResult | ScmCall): unknown;
  connected?: boolean;
}

/** Parent side: answers `scm-call` messages from one child with `scm`. */
export function serveScm(scm: ScmPort) {
  return (message: { type: string; [k: string]: unknown }, child: Channel) => {
    if (message.type !== 'scm-call') return;
    const call = message as unknown as ScmCall;
    const reply = (result: ScmResult) => {
      // The child may be gone (killed mid-call): its answer is simply lost.
      if (child.connected === false) return;
      try {
        child.send(result);
      } catch {
        /* Channel closed. */
      }
    };
    const method = (scm as unknown as Record<string, unknown>)[call.method];
    if (typeof method !== 'function' || call.method.startsWith('_')) {
      reply({
        type: 'scm-result',
        id: call.id,
        ok: false,
        error: { portError: false, message: `Unknown SCM method` },
      });
      return;
    }
    Promise.resolve()
      .then(() =>
        (method as (...a: unknown[]) => unknown).apply(scm, call.args),
      )
      .then(
        (value) => reply({ type: 'scm-result', id: call.id, ok: true, value }),
        (error: unknown) =>
          reply({
            type: 'scm-result',
            id: call.id,
            ok: false,
            error:
              error instanceof PortError
                ? {
                    portError: true,
                    category: error.category,
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                    ...(error.retryAfterMs === undefined
                      ? {}
                      : { retryAfterMs: error.retryAfterMs }),
                  }
                : {
                    portError: false,
                    message:
                      error instanceof Error ? error.message : 'SCM failure',
                  },
          }),
      );
  };
}

/** Child side: a `ScmPort` whose every method is a call to the parent. */
export function remoteScm(channel: {
  send(message: ScmCall): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
}): ScmPort {
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  channel.on('message', (raw) => {
    const message = raw as ScmResult;
    if (message?.type !== 'scm-result') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value);
    else {
      const e = message.error;
      waiter.reject(
        e.portError
          ? new PortError(
              e.category as PortError['category'],
              e.code ?? 'unknown',
              e.message,
              e.retryable ?? false,
              e.retryAfterMs,
            )
          : new Error(e.message),
      );
    }
  });
  return new Proxy({} as ScmPort, {
    get(_target, property) {
      // Not a thenable: `await remoteScm(...)` must not call the parent.
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = ++next;
          pending.set(id, { resolve, reject });
          channel.send({ type: 'scm-call', id, method: property, args });
        });
    },
  });
}

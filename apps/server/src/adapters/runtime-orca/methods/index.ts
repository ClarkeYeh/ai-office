import { z } from 'zod';
import type { RuntimePort, RuntimeHealth } from '../../../ports/runtime.js';
import type { OrcaObserver } from '../observe/index.js';
import { sessionRef, agentRef } from '../refs.js';
import { Context, type MethodOptions, marker, text } from './context.js';
import { Workspaces } from './workspaces.js';
import { Agents } from './agents.js';
export type { MethodOptions } from './context.js';
export interface OrcaRuntimeOptions extends MethodOptions {
  /** T6/T10 supplies observe; methods share the same ledger and identity. */
  observer: Pick<OrcaObserver, 'observe'>;
  version: {
    check(force?: boolean): Promise<{
      version: string;
      verified: boolean;
      warnings?: RuntimeHealth['warnings'];
    }>;
  };
  binPath?: string;
  supportedRange?: string;
  metrics?: {
    snapshot(): {
      completedCallsPerMinute: number;
      cpuSecondsPerMinute: number;
    };
  };
  now?: () => number;
}
export function createOrcaRuntime(options: OrcaRuntimeOptions): RuntimePort {
  const c = new Context(options),
    ws = new Workspaces(c),
    agents = new Agents(c, ws);
  const flights = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const existing = flights.get(id);
    if (existing) return existing as Promise<T>;
    const pending = operation().finally(() => flights.delete(id));
    flights.set(id, pending);
    return pending;
  };
  let health: { at: number; value: RuntimeHealth } | undefined;
  return {
    capabilities: () => ({
      sharedWorkspace: true,
      exactBranchNaming: true,
      structuredTranscript: true,
      correlationSearch: true,
      callerChosenRequestId: true,
    }),
    async health() {
      const now = options.now?.() ?? Date.now();
      const modeWarnings: NonNullable<RuntimeHealth['warnings']> =
        options.state.read('orca:chat-worker-degraded')
          ? ['chat_worker_identity_degraded']
          : [];
      if (health && now - health.at < 60_000)
        return structuredClone({
          ...health.value,
          ...options.identity.health(),
          warnings: [
            ...new Set([...(health.value.warnings ?? []), ...modeWarnings]),
          ],
        });
      const version = await options.version.check(true),
        identity = options.identity.health();
      const value: RuntimeHealth = {
        available: true,
        version: version.version,
        verified: version.verified,
        ...identity,
        warnings: [
          ...(identity.warnings ?? []),
          ...(version.warnings ?? []),
          ...modeWarnings,
        ],
        ...(options.binPath ? { binPath: options.binPath } : {}),
        ...(options.supportedRange
          ? { supportedRange: options.supportedRange }
          : {}),
        ...(options.metrics
          ? {
              cliCallsPerMinute:
                options.metrics.snapshot().completedCallsPerMinute,
              cpuSecondsPerMinute:
                options.metrics.snapshot().cpuSecondsPerMinute,
            }
          : {}),
      };
      health = { at: now, value };
      return structuredClone(value);
    },
    async openSession(req) {
      c.check(req.correlation.commandId, req);
      return serial(req.correlation.commandId, async () => {
        const r = await c.call(
          [
            'orchestration',
            'run-create',
            '--objective',
            `${req.objective} ${marker(req.correlation.commandId)}`,
          ],
          z.looseObject({ run: z.looseObject({ id: text }) }),
          undefined,
          req.correlation.commandId,
        );
        await options.identity.track(r.run.id);
        c.session(r.run.id, req.repo);
        c.save(req.correlation.commandId, {
          kind: 'runtime.openSession',
          result: { session: r.run.id },
        });
        return sessionRef(r.run.id);
      });
    },
    async closeSession(session) {
      options.logger.info(
        { run: session },
        'Runtime session closed; Orca retains run history',
      );
    },
    reclaimSession: (session) => options.identity.reclaimSession(session),
    async prepareWorkspace(req) {
      c.check(req.correlation.commandId, req);
      return serial(req.correlation.commandId, () => ws.prepare(req));
    },
    disposeWorkspace: (workspace) => ws.dispose(workspace),
    findWorkspace: (req) => ws.find(req),
    inspectWorkspace: (workspace) => ws.inspect(workspace),
    inspectLocalRepo: (path) => ws.inspectRepo(path),
    async spawnAgent(req) {
      c.check(req.correlation.commandId, req);
      return serial(req.correlation.commandId, () => agents.spawn(req));
    },
    spawnedWorkspace: (commandId) => agents.spawned(commandId),
    send: async (agent, msg) => {
      c.check(msg.correlation.commandId, { agent, msg });
      return serial(msg.correlation.commandId, () => agents.send(agent, msg));
    },
    answer: (question, body, correlation) =>
      agents.answer(question, body, correlation),
    stop: (agent) => agents.stop(agent),
    release: (agent, opts) => agents.release(agent, opts),
    inspectRequest: (request, id) => agents.inspect(request, id),
    findCommandByMarker: (id) => agents.find(id),
    async findByCorrelation(_session, id) {
      const r = await agents.find(id);
      return r?.kind === 'runtime.spawnAgent'
        ? agentRef(r.result.agent)
        : r?.kind === 'runtime.openSession'
          ? sessionRef(r.result.session)
          : null;
    },
    resolveCaller: (identity) => agents.resolve(identity),
    observe: (session, cursor) => options.observer.observe(session, cursor),
  };
}

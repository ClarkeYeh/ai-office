import { evolveGlobal, initialGlobalReadModel } from '@ai-office/projection';
import type { EventStore } from '../../ports/stores.js';
import { withGateBodies, type GateBodyDeps } from './gate-bodies.js';
import type { ProjectionService } from './projection-service.js';
export { ProjectionService } from './projection-service.js';
export type { WorkflowSnapshot } from './projection-service.js';
export {
  RepoCandidateQueries,
  matchRepoCandidates,
} from './repo-candidates.js';
export type { RepoCandidates } from './repo-candidates.js';

/** Transport-neutral read use cases; missing entities return null for the API to map to 404. */
export class QueryService {
  private global;
  constructor(
    private readonly events: EventStore,
    private readonly projections: ProjectionService,
    runtimeMode: 'orca' | 'fake' = 'orca',
    private readonly gateBodies: GateBodyDeps = {},
  ) {
    this.global = initialGlobalReadModel(runtimeMode);
  }

  private current() {
    for (;;) {
      const batch = this.events.read({
        afterSeq: this.global.lastSeq,
        limit: 200,
      });
      for (const event of batch) this.global = evolveGlobal(this.global, event);
      if (batch.length < 200) break;
    }
    return this.global;
  }

  getWorkflow(id: string) {
    return this.projections.snapshot(id);
  }
  listWorkflows() {
    return structuredClone({ workflows: this.current().workflowList });
  }
  listGates() {
    return structuredClone({ gates: this.current().gateInbox });
  }
  /** Conclusion gates also get request-time `githubBody` and `renderedBody` (G3b). */
  async getGate(id: string) {
    const gate = structuredClone(
      Object.values(this.current().workflows)
        .flatMap((w) => w.gates)
        .find((g) => g.gateId === id) ?? null,
    );
    return gate && withGateBodies(gate, this.events, this.gateBodies);
  }
  listQuestions() {
    return structuredClone({ questions: this.current().escalatedQuestions });
  }
  getSeat(id: string) {
    return structuredClone(
      Object.values(this.current().workflows)
        .flatMap((w) => w.seats)
        .find((s) => s.seatId === id) ?? null,
    );
  }
  listRepos() {
    return structuredClone({ repos: this.current().repos });
  }
  getRepo(id: string) {
    return structuredClone(
      this.current().repos.find((r) => r.repoId === id) ?? null,
    );
  }
  getHealth() {
    return structuredClone(this.current().health);
  }

  getEvents(workflowId: string, { afterSeq = 0, limit = 200 } = {}) {
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      limit >= Number.MAX_SAFE_INTEGER
    )
      throw new RangeError('Invalid event pagination');
    const page = this.events.read({ workflowId, afterSeq, limit: limit + 1 });
    const events = page.slice(0, limit);
    const last = events.at(-1);
    return {
      events,
      ...(page.length > limit && last ? { nextAfterSeq: last.seq } : {}),
    };
  }
}

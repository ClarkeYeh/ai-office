import {
  AnswerQuestionRequestSchema,
  GateDecisionRequestSchema,
  RegisterRepoRequestSchema,
  SeatMessageRequestSchema,
  StartWorkflowRequestSchema,
  EventsQuerySchema,
  type apiEndpoints,
} from '@ai-office/contracts/api';
import type { FastifyRequest } from 'fastify';
import type { ApplicationFacade } from '../../application/facade.js';
import type { QueryService } from '../../application/queries/index.js';
import type { TemplateQueries } from '../../application/queries/templates.js';
import { ApiError } from '../errors.js';

export interface RouteDependencies {
  commands: Omit<ApplicationFacade, 'runners'>;
  queries: Pick<
    QueryService,
    | 'getHealth'
    | 'listRepos'
    | 'getRepo'
    | 'listWorkflows'
    | 'getWorkflow'
    | 'getEvents'
    | 'listGates'
    | 'getGate'
    | 'listQuestions'
    | 'getSeat'
  >;
  templates: Pick<TemplateQueries, 'listTemplates' | 'getTemplate'>;
}
type Operation = Exclude<
  (typeof apiEndpoints)[number]['operationId'],
  'bootstrap' | 'streamEvents' | 'submitAgent'
>;
// JSON never supplies undefined; strip absent Zod optional values for exact optional types.
type Defined<T> = T extends readonly (infer U)[]
  ? Defined<U>[]
  : T extends object
    ? { [K in keyof T]: Defined<Exclude<T[K], undefined>> }
    : T;
const defined = <T>(value: T): Defined<T> => {
  if (Array.isArray(value)) return value.map(defined) as Defined<T>;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, defined(entry)]),
    ) as Defined<T>;
  return value as Defined<T>;
};
const found = <T>(value: T | null): T => {
  if (value === null) throw new ApiError('not_found');
  return value;
};

/** All writes go through command use cases; reads use the application read side. */
export function routeHandlers(
  deps: RouteDependencies,
): Record<Operation, (request: FastifyRequest) => unknown> {
  const { commands, queries, templates } = deps;
  const id = (r: FastifyRequest) => (r.params as { id: string }).id;
  const seatId = (r: FastifyRequest) => (r.params as { seatId: string }).seatId;
  const key = (r: FastifyRequest) => r.headers['idempotency-key'] as string;
  return {
    getHealth: () => queries.getHealth(),
    listRepos: () => queries.listRepos(),
    getRepo: (r) => found(queries.getRepo(id(r))),
    registerRepo: async (r) => {
      const repo = await commands.registerRepo(
        RegisterRepoRequestSchema.parse(r.body),
      );
      return found(queries.getRepo(repo.repoId));
    },
    listTemplates: () => templates.listTemplates(),
    getTemplate: async (r) => found(await templates.getTemplate(id(r))),
    listWorkflows: () => queries.listWorkflows(),
    startWorkflow: (r) =>
      commands.startWorkflow(defined(StartWorkflowRequestSchema.parse(r.body))),
    getWorkflow: (r) => found(queries.getWorkflow(id(r))),
    listEvents: (r) => {
      found(queries.getWorkflow(id(r)));
      return queries.getEvents(id(r), EventsQuerySchema.parse(r.query));
    },
    cancelWorkflow: async (r) => {
      await commands.cancelWorkflow(id(r));
      return { accepted: true };
    },
    cleanupWorkflow: async (r) => {
      await commands.cleanupWorkflow(id(r));
      return { accepted: true };
    },
    listGates: () => queries.listGates(),
    getGate: (r) => found(queries.getGate(id(r))),
    decideGate: async (r) => {
      await commands.decideGate(
        id(r),
        defined(GateDecisionRequestSchema.parse(r.body)),
        key(r),
      );
      return { accepted: true };
    },
    listQuestions: () => queries.listQuestions(),
    answerQuestion: async (r) => {
      await commands.answerQuestion(
        id(r),
        defined(AnswerQuestionRequestSchema.parse(r.body)),
        key(r),
      );
      return { accepted: true };
    },
    getSeat: (r) => found(queries.getSeat(seatId(r))),
    messageSeat: async (r) => {
      await commands.messageSeat(
        seatId(r),
        SeatMessageRequestSchema.parse(r.body),
      );
      return { accepted: true };
    },
  };
}

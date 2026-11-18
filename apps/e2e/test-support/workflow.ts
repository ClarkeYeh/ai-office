import { setTimeout as delay } from 'node:timers/promises';
import type {
  GateView,
  RepoView,
  WorkflowReadModel,
} from '@ai-office/contracts/api';
import type { Office } from './office.js';

/** Polls `read` until `done` holds; fails with the last value on timeout. */
export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}: ${JSON.stringify(value)}`,
      );
    await delay(100);
  }
}

export const isEnded = (model: WorkflowReadModel) =>
  ['completed', 'failed', 'cancelled'].includes(model.status);

export async function startWorkflow(
  office: Office,
  request: { templateId?: string; requirement?: string } = {},
): Promise<string> {
  const repos = await office.api<{ repos: RepoView[] }>('GET', '/api/v1/repos');
  const started = await office.api<{ workflowId: string }>(
    'POST',
    '/api/v1/workflows',
    {
      templateId: 'feature-to-pr',
      repoId: repos.body.repos[0]!.repoId,
      requirement: 'Add dark mode toggle',
      ...request,
    },
  );
  if (started.status !== 201)
    throw new Error(
      `start failed ${started.status} ${JSON.stringify(started.body)}`,
    );
  return started.body.workflowId;
}

export async function readModel(
  office: Office,
  workflowId: string,
): Promise<WorkflowReadModel> {
  return (
    await office.api<{ readModel: WorkflowReadModel }>(
      'GET',
      `/api/v1/workflows/${encodeURIComponent(workflowId)}`,
    )
  ).body.readModel;
}

export async function gates(
  office: Office,
  workflowId: string,
): Promise<GateView[]> {
  const { body } = await office.api<{ gates: GateView[] }>(
    'GET',
    '/api/v1/gates',
  );
  return body.gates.filter((gate) => gate.workflowId === workflowId);
}

/** The final PR number of an open final-pr gate, from the workflow read model. */
export async function finalPrNumber(
  office: Office,
  workflowId: string,
): Promise<number | undefined> {
  const gate = (await gates(office, workflowId)).find(
    (entry) => entry.stageKind === 'final-pr' && entry.status === 'open',
  );
  if (!gate) return undefined;
  const model = await readModel(office, workflowId);
  return model.gates.find((entry) => entry.gateId === gate.gateId)?.pr?.number;
}

/**
 * Approves open stage gates over HTTP until `done` holds. Final-PR gates are
 * left open: the caller merges them explicitly with `fake.mergeFinalPr` (S14).
 * Exception gates fail the drive.
 */
export async function approveStageGates(
  office: Office,
  workflowId: string,
  done: (model: WorkflowReadModel, open: GateView[]) => boolean,
  timeoutMs = 45_000,
): Promise<WorkflowReadModel> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const model = await readModel(office, workflowId);
    const open = (await gates(office, workflowId)).filter(
      (gate) => gate.status === 'open',
    );
    if (done(model, open)) return model;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out at ${model.status}; open gates: ${JSON.stringify(open.map((gate) => gate.title))}`,
      );
    for (const gate of open) {
      if (gate.kind === 'exception')
        throw new Error(`Unexpected exception gate: ${gate.title}`);
      if (gate.stageKind === 'final-pr' || gate.questionId !== undefined)
        continue;
      const detail = (
        await office.api<GateView>(
          'GET',
          `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
        )
      ).body;
      const conclusion = detail.conclusion;
      const decision = await office.api(
        'POST',
        `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
        {
          decision: 'approve',
          expectedVersion: detail.version,
          ...(conclusion === undefined
            ? {}
            : {
                githubBodyHash:
                  conclusion.githubBodyHash ?? conclusion.renderedHash,
              }),
        },
      );
      // A concurrent content update bumps the version: retry on the next pass.
      if (decision.status >= 300 && decision.status !== 409)
        throw new Error(
          `decision ${decision.status} ${JSON.stringify(decision.body)}`,
        );
    }
    await delay(100);
  }
}

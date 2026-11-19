import { ConclusionSchema } from '@ai-office/contracts/events';
import type {
  Conclusion,
  RepoSnapshot,
  ExternalCommand,
} from '@ai-office/contracts/events';
import { decide, isAttemptAlive, ownerReviewFeedback } from '@ai-office/domain';
import type {
  StartWorkflow,
  DecideGate,
  AnswerQuestion,
} from '@ai-office/domain';
import type { Clock, IdGen, Redactor } from '../../ports/services.js';
import type { EventStore, IdempotencyStore } from '../../ports/stores.js';
import type { TemplateRepository } from '../../ports/template.js';
import type { RuntimePort } from '../../ports/runtime.js';
import type { ReviewComment, ScmPort } from '../../ports/scm.js';
import type { WorkflowRunners } from '../runner/runners.js';
import {
  check,
  domainFailure,
  draft,
  fail,
  hash,
  Idempotency,
  issueBatch,
  issue,
  Serial,
} from './support.js';

export type StartWorkflowInput = Pick<
  StartWorkflow,
  'requirement' | 'roleOverrides' | 'budgetOverrides' | 'gateToggles'
> & {
  templateId: string;
  repoId: string;
  acknowledgeUnverifiedRuntime?: boolean;
};
export type GateDecisionInput = Omit<
  DecideGate,
  | 'type'
  | 'meta'
  | 'by'
  | 'gateId'
  | 'requestedGithubBodyHash'
  | 'currentGithubBodyHash'
  | 'approvedSnapshot'
> & { githubBodyHash?: string; githubUpdatedAt?: string };
export type AnswerInput = Pick<AnswerQuestion, 'body' | 'optionId'>;
export interface CommandUseCaseDeps {
  runners: WorkflowRunners;
  store: EventStore;
  templates: TemplateRepository;
  runtime: RuntimePort;
  scm: ScmPort;
  clock: Clock;
  ids: IdGen;
  idempotency: IdempotencyStore;
  redactor: Redactor;
  limits: StartWorkflow['limits'];
}
/** The owner's comment plus the owner's PR review comments (S10). */
export const revisionFeedback = (
  comment: string | undefined,
  review: { comments: readonly ReviewComment[]; ignored: number },
): string | undefined => {
  const parts = [
    ...(comment?.trim() ? [comment] : []),
    ...(review.comments.length === 0
      ? []
      : [
          [
            'Review comments by the repository owner on the final PR:',
            ...review.comments.map(
              (c) =>
                `- ${c.path}${c.line === null ? '' : `:${c.line}`}: ${c.body}`,
            ),
          ].join('\n'),
        ]),
    ...(review.ignored === 0
      ? []
      : [`(${review.ignored} review comment(s) by other accounts ignored.)`]),
  ];
  return parts.length === 0 ? undefined : parts.join('\n\n');
};
const fields = [
  'summary',
  'decisions',
  'techDecisions',
  'openQuestions',
] as const;
export const renderConclusion = (conclusion: Conclusion): string =>
  [
    '# Meeting conclusion',
    ...fields.flatMap((key) => [
      `<!-- ai-office:${key}:start -->`,
      `## ${key}`,
      JSON.stringify(conclusion[key], null, 2),
      `<!-- ai-office:${key}:end -->`,
    ]),
  ].join('\n\n');
export const parseConclusion = (body: string): Conclusion | null => {
  try {
    const values = Object.fromEntries(
      fields.map((key) => {
        const start = body.indexOf(`<!-- ai-office:${key}:start -->`);
        const end = body.indexOf(`<!-- ai-office:${key}:end -->`, start);
        if (start < 0 || end < 0) throw new Error('missing marker');
        const section = body
          .slice(start, end)
          .split('\n')
          .slice(1)
          .join('\n')
          .replace(/^\s*##[^\n]*\n/, '')
          .trim();
        return [key, JSON.parse(section)];
      }),
    );
    const result = ConclusionSchema.safeParse(values);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/** HTTP-independent command facade. Errors carry the status/code the inbound API returns. */
export class CommandUseCases {
  private idem: Idempotency;
  private serial = new Serial();
  constructor(private deps: CommandUseCaseDeps) {
    this.idem = new Idempotency(deps.idempotency, deps.clock);
  }
  private meta() {
    return {
      source: 'user' as const,
      occurredAt: this.deps.clock.now().toISOString(),
    };
  }
  private runner(id: string) {
    return this.deps.runners.get(id) ?? fail(404, 'unknown_workflow');
  }
  private locate(kind: 'gates' | 'questions', id: string) {
    return (
      this.deps.runners.all().find((r) => Object.hasOwn(r.state[kind], id)) ??
      fail(404, `unknown_${kind === 'gates' ? 'gate' : 'question'}`)
    );
  }
  private repos(): RepoSnapshot[] {
    const repos = new Map<string, RepoSnapshot>();
    for (const event of this.deps.store.read({ workflowId: null })) {
      if (event.type === 'repo.registered')
        repos.set(event.payload.repoId, event.payload);
      if (event.type === 'repo.updated') {
        const previous = repos.get(event.payload.repoId);
        if (previous) {
          const patch = Object.fromEntries(
            Object.entries(event.payload).filter(
              ([, value]) => value !== undefined,
            ),
          );
          repos.set(previous.repoId, { ...previous, ...patch });
        }
      }
    }
    return [...repos.values()];
  }
  async startWorkflow(
    input: StartWorkflowInput,
  ): Promise<{ workflowId: string }> {
    const { templates, runtime, ids, runners, limits } = this.deps;
    const template = await templates.get(input.templateId);
    if (!template) fail(404, 'unknown_template');
    if ('issues' in template)
      fail(422, 'template_invalid', JSON.stringify(template.issues));
    const repo =
      this.repos().find((r) => r.repoId === input.repoId) ??
      fail(404, 'unknown_repo');
    const health = await runtime.health();
    if (!health.available) fail(503, 'runtime_unavailable');
    if (!health.verified && !input.acknowledgeUnverifiedRuntime)
      fail(428, 'runtime_unverified');
    const workflowId = ids.ulid();
    const {
      templateId: _templateId,
      repoId: _repoId,
      acknowledgeUnverifiedRuntime,
      ...overrides
    } = input;
    void _templateId;
    void _repoId;
    check(
      await runners.start({
        ...overrides,
        type: 'StartWorkflow',
        meta: this.meta(),
        workflowId,
        shortId: ids.shortId(),
        template,
        repo,
        limits: { ...limits },
        acknowledgedUnverifiedRuntime: acknowledgeUnverifiedRuntime ?? false,
      }),
    );
    return { workflowId };
  }
  decideGate(
    gateId: string,
    input: GateDecisionInput,
    key: string,
  ): Promise<{ gateId: string }> {
    return this.idem.run(`gate:${gateId}`, key, input, async (record) => {
      const runner = this.locate('gates', gateId);
      return this.serial.run(runner.workflowId, async () => {
        const gate = runner.state.gates[gateId]!;
        const {
          githubBodyHash,
          githubUpdatedAt: _updatedAt,
          ...decision
        } = input;
        void _updatedAt;
        const sync: ExternalCommand[] = [];
        const command: DecideGate = {
          ...decision,
          type: 'DecideGate',
          meta: this.meta(),
          gateId,
          by: 'user',
        };
        if (gate.version !== input.expectedVersion)
          fail(409, 'gate_version_conflict');
        if (
          gate.kind === 'stage' &&
          gate.stageKind === 'meeting' &&
          ['approve', 'revise'].includes(input.decision)
        ) {
          const stageAttempt = runner.state.stages[gate.stageId]?.attempt;
          const artifact =
            runner.state.artifacts[
              `${runner.workflowId}/${gate.stageId}/${stageAttempt}/issue`
            ];
          if (!artifact || artifact.kind !== 'issue')
            fail(409, 'conclusion_issue_missing');
          let current;
          try {
            current = await this.deps.scm.getIssue({
              repo: runner.state.workflow!.repo.github,
              number: artifact.number,
            });
          } catch {
            return fail(503, 'scm_unavailable');
          }
          const currentHash = await hash(current.body);
          command.requestedGithubBodyHash = githubBodyHash ?? '';
          command.currentGithubBodyHash = currentHash;
          const edited =
            input.decision === 'revise' && input.edits?.type === 'conclusion'
              ? input.edits.conclusion
              : undefined;
          const body = edited ? renderConclusion(edited) : current.body;
          command.approvedSnapshot = {
            source: edited ? 'ai-office' : 'github',
            body,
            bodyHash: await hash(body),
            githubUpdatedAt: current.updatedAt,
            structured: edited ?? parseConclusion(body),
          };
          const issueRef = {
            repo: runner.state.workflow!.repo.github,
            number: artifact.number,
          };
          if (edited)
            sync.push({
              kind: 'scm.updateIssue',
              args: { issue: issueRef, patch: { body } },
            });
          sync.push({
            kind: 'scm.comment',
            args: {
              target: { ...issueRef, type: 'issue' },
              body: `${input.decision} at ${command.meta.occurredAt}${input.comment ? `: ${input.comment}` : ''}`,
            },
          });
          sync.push({
            kind: 'scm.setLabels',
            args: {
              target: { ...issueRef, type: 'issue' },
              labels: [
                ...current.labels.filter(
                  (label) => label !== 'ai-office:pending',
                ),
                'ai-office:approved',
              ],
            },
          });
        }
        // S10: a final-PR revision carries the owner's PR review comments;
        // on a public repository anyone can review, so others only count.
        const workflow = runner.state.workflow!;
        if (
          gate.kind === 'stage' &&
          gate.stageKind === 'final-pr' &&
          input.decision === 'reject' &&
          workflow.finalPr !== undefined
        ) {
          let comments;
          try {
            comments = await this.deps.scm.listReviewComments({
              repo: workflow.repo.github,
              number: workflow.finalPr,
            });
          } catch {
            return fail(503, 'scm_unavailable');
          }
          const feedback = revisionFeedback(
            input.comment,
            ownerReviewFeedback(comments, workflow.repo.ownerLogin),
          );
          if (feedback !== undefined)
            command.comment = this.deps.redactor.maskSecrets(feedback);
        }
        // No await between checking current state and appending the atomic decision/outbox batch.
        const result = decide(runner.state, command);
        if (!result.ok) throw domainFailure(result.error);
        await issueBatch(
          runner,
          this.deps.clock,
          this.deps.ids,
          sync,
          result.events,
          record({ gateId }),
        );
        return { gateId };
      });
    });
  }
  answerQuestion(
    questionId: string,
    input: AnswerInput,
    key: string,
  ): Promise<{ questionId: string }> {
    return this.idem.run(
      `question:${questionId}`,
      key,
      input,
      async (record) => {
        const runner = this.locate('questions', questionId);
        return this.serial.run(runner.workflowId, async () => {
          if (!input.body.trim()) fail(422, 'empty_answer');
          const gateId = runner.state.questions[questionId]?.escalation?.gateId;
          const gate = gateId ? runner.state.gates[gateId] : undefined;
          if (!gate || gate.status !== 'open')
            fail(409, 'question_gate_not_open');
          const result = decide(runner.state, {
            ...input,
            type: 'AnswerQuestion',
            questionId,
            by: 'user',
            gateId: gate.gateId,
            meta: this.meta(),
          });
          if (!result.ok) throw domainFailure(result.error);
          await runner.append(
            [
              ...result.events,
              draft(this.deps.clock, runner.workflowId, 'gate.decided', {
                gateId: gate.gateId,
                version: gate.version,
                decision: 'answer',
                by: 'user',
                comment: input.body,
                ...(input.optionId === undefined
                  ? {}
                  : { optionId: input.optionId }),
              }),
            ],
            undefined,
            record({ questionId }),
          );
          return { questionId };
        });
      },
    );
  }
  async cancelWorkflow(workflowId: string): Promise<{ workflowId: string }> {
    check(
      await this.runner(workflowId).dispatch({
        type: 'RequestCancel',
        by: 'user',
        meta: this.meta(),
      }),
    );
    return { workflowId };
  }
  async messageSeat(
    seatId: string,
    input: { subject: string; body: string },
  ): Promise<{ commandId: string }> {
    const runner =
      this.deps.runners
        .all()
        .find((r) =>
          Object.values(r.state.attempts).some(
            (a) => a.seatId === seatId && isAttemptAlive(a),
          ),
        ) ?? fail(409, 'no_live_attempt');
    return this.serial.run(runner.workflowId, async () => {
      const attempt = Object.values(runner.state.attempts).find(
        (a) => a.seatId === seatId && isAttemptAlive(a),
      );
      if (!attempt?.agentRef) fail(409, 'no_live_attempt');
      if (!input.subject.trim() || !input.body.trim())
        fail(422, 'empty_message');
      const safe = this.deps.redactor.maskSecrets(input);
      const commandId = await issue(
        runner,
        this.deps.clock,
        this.deps.ids,
        { kind: 'runtime.send', args: { agent: attempt.agentRef, ...safe } },
        [
          draft(this.deps.clock, runner.workflowId, 'message.instruction', {
            seatId,
            attemptId: attempt.attemptId,
            ...safe,
          }),
        ],
      );
      return { commandId };
    });
  }
  async cleanupWorkflow(
    workflowId: string,
  ): Promise<{ workflowId: string; commandIds: string[] }> {
    return this.serial.run(workflowId, async () => {
      const runner = this.runner(workflowId);
      const workflow = runner.state.workflow!;
      if (workflow.status === 'running') fail(409, 'workflow_not_terminal');
      const commands: ExternalCommand[] = [];
      const workspaces = new Set<string>();
      const branches = new Set<string>();
      for (const record of Object.values(runner.state.commands)) {
        if (
          record.issued.kind === 'runtime.prepareWorkspace' &&
          record.result?.kind === 'runtime.prepareWorkspace' &&
          record.result.result !== null &&
          'workspace' in record.result.result
        ) {
          workspaces.add(record.result.result.workspace);
          branches.add(record.issued.args.branch);
        }
      }
      // M2-T17 D9: agents spawned into a `new-worktree` (e.g. the planning
      // lead) create their worktree inside runtime.spawnAgent, with no
      // prepareWorkspace command; resolve it by its deterministic name/marker.
      for (const [commandId, record] of Object.entries(runner.state.commands)) {
        if (
          record.issued.kind !== 'runtime.spawnAgent' ||
          record.issued.args.workspace.kind !== 'new-worktree' ||
          record.result?.kind !== 'runtime.spawnAgent'
        )
          continue;
        const { name, branch } = record.issued.args.workspace;
        branches.add(branch);
        const created = await this.deps.runtime
          .findWorkspace({
            repo: {
              orcaRepoId: workflow.repo.orcaRepoId,
              localPath: workflow.repo.localPath,
            },
            name,
            commandId: `${commandId}/workspace`,
          })
          .catch(() => null);
        if (created) workspaces.add(created.workspace);
      }
      for (const item of Object.values(runner.state.workItems))
        if (item.branch) branches.add(item.branch);
      for (const workspace of workspaces)
        commands.push({
          kind: 'runtime.disposeWorkspace',
          args: { workspace },
        });
      for (const name of branches)
        if (
          name.startsWith(`ai-office/${workflow.shortId}/`) &&
          name !== workflow.integrationBranch &&
          name !== workflow.repo.defaultBranch
        )
          commands.push({
            kind: 'scm.deleteBranch',
            args: { repo: workflow.repo.github, name },
          });
      const commandIds: string[] = [];
      for (const command of commands)
        commandIds.push(
          await issue(runner, this.deps.clock, this.deps.ids, command),
        );
      return { workflowId, commandIds };
    });
  }
  async registerRepo(input: { localPath: string }): Promise<RepoSnapshot> {
    return this.serial.run('repos', async () => {
      const existing = this.repos().find(
        (r) => r.localPath === input.localPath,
      );
      if (existing) return existing;
      const local = await this.deps.runtime.inspectLocalRepo(input.localPath);
      if (!local.isGitMainWorktree) fail(422, 'repo_not_main_worktree');
      if (!local.runtimeRepoId) fail(422, 'repo_not_in_orca');
      const match =
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
          local.originUrl ?? '',
        );
      if (!match) fail(422, 'invalid_github_origin');
      const github = { owner: match[1]!, name: match[2]! };
      const info = await this.deps.scm.inspectRepo(github);
      const repo: RepoSnapshot = {
        repoId: this.deps.ids.ulid(),
        localPath: input.localPath,
        orcaRepoId: local.runtimeRepoId,
        github,
        defaultBranch: info.defaultBranch,
        visibility: info.visibility,
        ownerLogin: info.viewerLogin,
        defaultBranchProtected: info.defaultBranchProtected,
      };
      this.deps.store.append([
        draft(this.deps.clock, null, 'repo.registered', repo),
      ]);
      return repo;
    });
  }
}

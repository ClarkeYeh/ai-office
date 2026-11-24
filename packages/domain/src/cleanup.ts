import type { ExternalCommand } from '@ai-office/contracts/events';
import type { WorkflowState } from './state/index.js';

export type CleanupCommand = Extract<
  ExternalCommand,
  { kind: 'runtime.disposeWorkspace' | 'scm.deleteBranch' }
>;

/** One cleanup command; `resource` names it for deterministic command ids. */
export interface CleanupTarget {
  resource: ['workspace' | 'branch', string];
  command: CleanupCommand;
}

/** A `new-worktree` spawn whose recorded result carries no `workspace` (older events). */
export interface UnresolvedSpawnWorkspace {
  commandId: string;
  name: string;
}

const spawnRecords = (state: WorkflowState) =>
  Object.entries(state.commands).flatMap(([commandId, record]) =>
    record.issued.kind === 'runtime.spawnAgent' &&
    record.issued.args.workspace.kind === 'new-worktree' &&
    record.result?.kind === 'runtime.spawnAgent'
      ? [
          {
            commandId,
            workspace: record.issued.args.workspace,
            created: record.result.result.workspace,
          },
        ]
      : [],
  );

/**
 * M5 §4.2: `new-worktree` spawns recorded before `spawnAgent` results carried
 * `workspace`. `POST /cleanup` resolves them with `findWorkspace`; the engine
 * skips them.
 */
export const unresolvedSpawnWorkspaces = (
  state: WorkflowState,
): UnresolvedSpawnWorkspace[] =>
  spawnRecords(state)
    .filter((spawn) => spawn.created === undefined)
    .map(({ commandId, workspace }) => ({ commandId, name: workspace.name }));

/**
 * The workflow's leftover resources, read from state only (M5 §4.2): the
 * worktrees from `prepareWorkspace` and `new-worktree` spawns, then their
 * branches and the work item branches. Branches are limited to
 * `ai-office/<shortId>/`, never the integration or default branch. `resolved`
 * supplies workspaces for {@link unresolvedSpawnWorkspaces}, by spawn command id.
 */
export const collectCleanup = (
  state: WorkflowState,
  resolved: ReadonlyMap<string, string> = new Map(),
): CleanupTarget[] => {
  const workflow = state.workflow;
  if (workflow === null) return [];
  const workspaces = new Set<string>();
  const branches = new Set<string>();
  for (const record of Object.values(state.commands))
    if (
      record.issued.kind === 'runtime.prepareWorkspace' &&
      record.result?.kind === 'runtime.prepareWorkspace' &&
      record.result.result !== null &&
      'workspace' in record.result.result
    ) {
      workspaces.add(record.result.result.workspace);
      branches.add(record.issued.args.branch);
    }
  // M2-T17 D9: agents spawned into a `new-worktree` (e.g. the planning lead)
  // create their worktree inside runtime.spawnAgent, with no prepareWorkspace.
  for (const spawn of spawnRecords(state)) {
    branches.add(spawn.workspace.branch);
    const created = spawn.created ?? resolved.get(spawn.commandId);
    if (created !== undefined) workspaces.add(created);
  }
  for (const item of Object.values(state.workItems))
    if (item.branch) branches.add(item.branch);
  return [
    ...[...workspaces].map((workspace): CleanupTarget => ({
      resource: ['workspace', workspace],
      command: { kind: 'runtime.disposeWorkspace', args: { workspace } },
    })),
    ...[...branches]
      .filter(
        (name) =>
          name.startsWith(`ai-office/${workflow.shortId}/`) &&
          name !== workflow.integrationBranch &&
          name !== workflow.repo.defaultBranch,
      )
      .map((name): CleanupTarget => ({
        resource: ['branch', name],
        command: {
          kind: 'scm.deleteBranch',
          args: { repo: workflow.repo.github, name },
        },
      })),
  ];
};

/**
 * What a failed cleanup command left behind, read from its issued args (M5
 * §4.2: `cleanup-failed` carries only the command id; the resource comes from
 * the command ledger).
 */
export const cleanupResource = (
  state: WorkflowState,
  commandId: string,
): CleanupTarget['resource'] | undefined => {
  const issued = state.commands[commandId]?.issued;
  if (issued?.kind === 'runtime.disposeWorkspace')
    return ['workspace', issued.args.workspace];
  if (issued?.kind === 'scm.deleteBranch') return ['branch', issued.args.name];
  return undefined;
};

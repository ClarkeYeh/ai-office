import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { REPO, assertBranch, assertCommand, assertRunId } from './safety.js';

const resourceSchema = z.object({
  kind: z.enum(['pr', 'issue', 'comment', 'branch', 'localBranch', 'status']),
  key: z.string(),
  number: z.number().int().positive().optional(),
  state: z.enum(['intent', 'created', 'done']),
});
export const LedgerSchema = z.object({
  format: z.literal(1),
  repo: z.literal(REPO),
  runId: z.string().regex(/^[a-f0-9]{12}$/),
  createdAt: z.string().datetime(),
  claims: z.array(z.string().regex(/^[a-zA-Z0-9]+$/)).default([]),
  commands: z.array(z.string().regex(/^[a-zA-Z0-9:_/-]+$/)).default([]),
  resources: z.array(resourceSchema),
});
export type Resource = z.infer<typeof resourceSchema>;
export type ResourceLedger = z.infer<typeof LedgerSchema>;
export function emptyLedger(runId: string): ResourceLedger {
  assertRunId(runId);
  return {
    format: 1,
    repo: REPO,
    runId,
    createdAt: new Date().toISOString(),
    claims: [],
    commands: [],
    resources: [],
  };
}
export function validateResource(
  ledger: ResourceLedger,
  resource: Resource,
): void {
  if (resource.kind === 'branch' || resource.kind === 'localBranch')
    assertBranch(resource.key, ledger.runId, ledger.claims);
  else if (!ledger.commands.includes(resource.key))
    assertCommand(resource.key, ledger.runId, ledger.claims);
  if (resource.number === 3)
    throw new Error('PR 3 is never a harness resource');
}
export async function saveLedger(
  path: string,
  ledger: ResourceLedger,
): Promise<void> {
  LedgerSchema.parse(ledger);
  for (const resource of ledger.resources) validateResource(ledger, resource);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try {
    await fd.writeFile(JSON.stringify(ledger));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temporary, path);
}
export async function loadLedger(path: string): Promise<ResourceLedger> {
  const ledger = LedgerSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  for (const resource of ledger.resources) validateResource(ledger, resource);
  return ledger;
}
export function leftovers(ledger: ResourceLedger): Resource[] {
  return ledger.resources.filter(
    (r) => r.state !== 'done' && r.kind !== 'status',
  );
}
export class Ledger {
  constructor(
    readonly path: string,
    readonly data: ResourceLedger,
  ) {}
  save = () => saveLedger(this.path, this.data);
  async intent(kind: Resource['kind'], key: string): Promise<Resource> {
    const prior = this.data.resources.find(
      (r) => r.kind === kind && r.key === key && r.state !== 'done',
    );
    if (prior) return prior;
    const resource: Resource = { kind, key, state: 'intent' };
    validateResource(this.data, resource);
    this.data.resources.push(resource);
    await this.save();
    return resource;
  }
  async created(resource: Resource, number?: number): Promise<void> {
    if (number !== undefined) resource.number = number;
    validateResource(this.data, resource);
    resource.state = 'created';
    await this.save();
  }
  async done(resource: Resource): Promise<void> {
    resource.state = 'done';
    await this.save();
  }
}

/** T17 passes the issued command and matching succeeded result, never raw bodies. */
export async function registerSucceeded(
  ledger: Ledger,
  shortId: string,
  command: {
    commandId: string;
    kind: string;
    args: { repo?: { owner: string; name: string }; name?: string };
  },
  result: { repo?: { owner: string; name: string }; number?: number },
): Promise<void> {
  if (!/^[a-zA-Z0-9]+$/.test(shortId))
    throw new Error('Invalid production claim');
  const repo = result.repo ?? command.args.repo;
  if (!repo || `${repo.owner}/${repo.name}` !== REPO)
    throw new Error('Event repository mismatch');
  const kind =
    command.kind === 'scm.openPR'
      ? 'pr'
      : command.kind === 'scm.createIssue'
        ? 'issue'
        : command.kind === 'scm.ensureBranch'
          ? 'branch'
          : undefined;
  if (!kind) throw new Error('Unsupported succeeded resource');
  if (!ledger.data.claims.includes(shortId)) ledger.data.claims.push(shortId);
  const key = kind === 'branch' ? command.args.name : command.commandId;
  if (!key || (kind !== 'branch' && (!result.number || result.number === 3)))
    throw new Error('Incomplete succeeded resource');
  if (kind !== 'branch' && !ledger.data.commands.includes(key))
    ledger.data.commands.push(key);
  await ledger.created(await ledger.intent(kind, key), result.number);
}

/** Import only matching issued/succeeded pairs from one explicitly selected workflow. */
export async function registerEvents(
  ledger: Ledger,
  events: readonly {
    type: string;
    workflowId?: string | null;
    payload: unknown;
  }[],
  workflowId: string,
  shortId: string,
): Promise<void> {
  const commands = new Map<string, Parameters<typeof registerSucceeded>[2]>();
  for (const event of events) {
    if (event.workflowId !== workflowId) continue;
    if (event.type === 'command.issued') {
      const command = event.payload as Parameters<typeof registerSucceeded>[2];
      if (
        ['scm.ensureBranch', 'scm.createIssue', 'scm.openPR'].includes(
          command.kind,
        )
      )
        commands.set(command.commandId, command);
    }
    if (event.type === 'command.succeeded') {
      const succeeded = event.payload as {
        commandId: string;
        kind: string;
        result: { issue?: number; pr?: number };
      };
      const command = commands.get(succeeded.commandId);
      if (!command) continue;
      if (command.kind !== succeeded.kind)
        throw new Error('Event command kind mismatch');
      const number = succeeded.result.issue ?? succeeded.result.pr;
      await registerSucceeded(
        ledger,
        shortId,
        command,
        number === undefined ? {} : { number },
      );
    }
  }
}

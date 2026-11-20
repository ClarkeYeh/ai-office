import { claims, type ResourceLedger } from './ledger.js';
import { requireOwned, testBranch, testWorktree } from './safety.js';

/** Fail closed: callers cannot smuggle additional flags or alternate selectors. */
export function assertCommand(
  args: readonly string[],
  ledger: ResourceLedger,
  agents: boolean,
): void {
  const [group, action] = args;
  const flags = new Map<string, string>();
  const switches = new Set([
    '--json',
    '--full',
    '--delete-branch',
    '--keep-open',
    '--no-parent',
    '--wait',
  ]);
  for (let i = 2; i < args.length; i++) {
    const key = args[i]!;
    if (!key.startsWith('--') || flags.has(key))
      throw new Error('Invalid harness command flags');
    if (switches.has(key)) flags.set(key, '');
    else {
      const value = args[++i];
      if (!value || value.startsWith('--'))
        throw new Error('Missing harness flag value');
      flags.set(key, value);
    }
  }
  let allowed: string[];
  const own = (key: string, ids: string[]) => requireOwned(flags.get(key), ids);
  const from = () =>
    own(
      '--from',
      ledger.shims.filter((s) => !s.done).map((s) => s.id),
    );
  const dispatch = () =>
    own(
      '--dispatch',
      ledger.dispatches.map((s) => s.id),
    );
  if (group === 'status' && action === '--json' && args.length === 2) return;
  if (group === 'orchestration') {
    switch (action) {
      case 'reply':
        own('--id', ledger.messages);
        own('--run', ledger.runs);
        from();
        allowed = ['--id', '--run', '--from', '--body', '--retry-request'];
        break;
      case 'request-show':
        own('--request', ledger.requests);
        allowed = ['--request'];
        break;
      case 'run-create':
        from();
        if (!flags.get('--objective')?.startsWith('aio-test-'))
          throw new Error('Test objective required');
        allowed = ['--from', '--objective', '--retry-request'];
        break;
      case 'run-use':
        own('--id', ledger.runs);
        from();
        allowed = ['--id', '--from', '--retry-request'];
        break;
      case 'run-show':
        own('--id', ledger.runs);
        allowed = ['--id'];
        break;
      case 'task-list':
        own('--run', ledger.runs);
        if (flags.has('--from')) from();
        allowed = ['--run', '--from'];
        break;
      case 'inbox':
        own(
          '--terminal',
          ledger.runs.map((r) => `run:${r}`),
        );
        allowed = ['--terminal', '--limit'];
        break;
      case 'check':
        own(
          '--terminal',
          ledger.shims.filter((s) => !s.done).map((s) => s.id),
        );
        own('--run', ledger.runs);
        allowed = [
          '--terminal',
          '--run',
          '--wait',
          '--timeout-ms',
          '--retry-request',
          '--types',
        ];
        break;
      case 'worker-show':
      case 'worker-stop':
      case 'worker-release':
        dispatch();
        allowed =
          action === 'worker-show'
            ? ['--dispatch']
            : ['--dispatch', '--retry-request'];
        break;
      case 'worker-list':
        own('--run', ledger.runs);
        allowed = ['--run'];
        break;
      case 'worker-start':
        if (!agents) throw new Error('Agent tests disabled');
        from();
        own(
          '--worktree',
          ledger.worktrees.filter((w) => !w.done).map((w) => `id:${w.id}`),
        );
        allowed = [
          '--from',
          '--worktree',
          '--agent',
          '--spec',
          '--keep-open',
          '--retry-request',
        ];
        break;
      case 'send':
        if (!agents) throw new Error('Agent tests disabled');
        from();
        own(
          '--to',
          ledger.dispatches.map((d) => `dispatch:${d.id}`),
        );
        if (!flags.get('--subject')?.startsWith('aio:'))
          throw new Error('Test subject required');
        allowed = ['--from', '--to', '--subject', '--body', '--retry-request'];
        break;
      case 'task-update':
        own(
          '--id',
          ledger.tasks.map((t) => t.id),
        );
        own('--run', ledger.runs);
        from();
        if (flags.get('--status') !== 'failed')
          throw new Error('Cleanup may only fail test tasks');
        allowed = [
          '--id',
          '--status',
          '--result',
          '--run',
          '--from',
          '--retry-request',
        ];
        break;
      default:
        throw new Error('Orca command not allowed by harness');
    }
  } else if (group === 'worktree' && action === 'rm') {
    own(
      '--worktree',
      ledger.worktrees.map((w) => `id:${w.id}`),
    );
    const item = ledger.worktrees.find(
      (w) => `id:${w.id}` === flags.get('--worktree'),
    )!;
    testWorktree(item.name, item.comment, claims(ledger));
    // M3-T17: a detached worktree has no branch, so nothing to delete with it.
    if (item.branch === '') allowed = ['--worktree'];
    else {
      testBranch(item.branch, false, claims(ledger));
      allowed = ['--worktree', '--delete-branch'];
    }
  } else if (group === 'terminal' && action === 'close') {
    own(
      '--terminal',
      ledger.shims.map((s) => s.id),
    );
    allowed = ['--terminal'];
  } else throw new Error('Orca command not allowed by harness');
  for (const key of flags.keys())
    if (
      ![
        '--json',
        ...(group === 'orchestration' ? ['--full'] : []),
        ...allowed,
      ].includes(key)
    )
      throw new Error('Orca flag not allowed by harness');
}

import type { PolicyHit } from '../../ports/services.js';

/** Small lexical scanner, not a shell interpreter. Never executes agent input. */
function commands(source: string): string[][] {
  const result: string[][] = [];
  let words: string[] = [],
    word = '',
    quote = '';
  const flush = () => {
    if (word) words.push(word);
    word = '';
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '\\' && quote !== "'") {
      const next = source[++i];
      if (next !== undefined && next !== '\n') word += next;
    } else if (quote) {
      if (c === quote) quote = '';
      else word += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (';|&\n'.includes(c)) {
      flush();
      if (words.length) result.push(words);
      words = [];
    } else if (/\s/.test(c)) flush();
    else word += c;
  }
  flush();
  if (words.length) result.push(words);
  return result;
}

/** Parse API flags without treating a header, payload or template as the endpoint. */
function apiWriteRule(args: string[]): PolicyHit['rule'] | undefined {
  let method: string | undefined;
  let hasBody = false;
  let endpoint: string | undefined;
  const valueFlags = new Set([
    '--method',
    '--field',
    '--raw-field',
    '--input',
    '--header',
    '--hostname',
    '--cache',
    '--jq',
    '--preview',
    '--template',
    '-X',
    '-F',
    '-f',
    '-H',
    '-q',
    '-p',
    '-t',
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const equals = arg.indexOf('=');
    const attachedShort = /^-[XFfHqpt].+/.test(arg);
    const flag = attachedShort
      ? arg.slice(0, 2)
      : equals >= 0
        ? arg.slice(0, equals)
        : arg;
    if (valueFlags.has(flag)) {
      const value = attachedShort
        ? arg.slice(2).replace(/^=/, '')
        : equals >= 0
          ? arg.slice(equals + 1)
          : args[++i];
      if (flag === '-X' || flag === '--method') method = value?.toUpperCase();
      if (['-F', '-f', '--field', '--raw-field', '--input'].includes(flag))
        hasBody = true;
    } else if (!arg.startsWith('-') && endpoint === undefined) endpoint = arg;
  }
  if (
    !['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      method ?? (hasBody ? 'POST' : 'GET'),
    )
  )
    return;
  const path = endpoint
    ?.replace(/^https?:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    ?.replace(/\/$/, '');
  if (!path) return;
  if (/^\/?repos\/[^/]+\/[^/]+\/(?:pulls\/\d+\/merge|merges)$/.test(path))
    return 'gh-merge';
  // The existing contract has no generic ref-write rule. Conservatively classify
  // all ref mutations as high-risk pushes, even if the body names another branch.
  if (/^\/?repos\/[^/]+\/[^/]+\/git\/refs(?:\/.*)?$/.test(path))
    return 'push-default-branch';
}

export function policyRules(
  source: string,
  defaultBranch: string,
  currentBranch?: string,
): Set<PolicyHit['rule']> {
  const hits = new Set<PolicyHit['rule']>();
  for (const words of commands(source)) {
    // Allow environment assignments and common command wrappers.
    while (
      words[0] &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) ||
        ['env', 'command', 'sudo'].includes(words[0]))
    ) {
      if (words[0]?.startsWith('GIT_')) currentBranch = undefined;
      words.shift();
    }
    const executable = words.shift()?.split('/').pop();
    if (executable === 'cd' || executable === 'pushd' || executable === 'popd')
      currentBranch = undefined;
    const [group, action] = words;
    if (executable === 'orca') {
      if (group === 'orchestration') {
        if (['worker-start', 'dispatch', 'run-create'].includes(action ?? ''))
          hits.add('orca-dispatch');
        if (action === 'run-use') hits.add('orca-run-use');
        if (['worker-stop', 'worker-release'].includes(action ?? ''))
          hits.add('orca-worker-stop');
      }
      if (
        (group === 'agent' && action === 'launch') ||
        (group === 'terminal' && action === 'create') ||
        (group === 'worktree' &&
          action === 'create' &&
          words.some((w) => w === '--agent' || w.startsWith('--agent=')))
      )
        hits.add('orca-agent-launch');
    }
    if (executable === 'gh') {
      if (group === 'pr' && action === 'merge') hits.add('gh-merge');
      if ((group === 'issue' || group === 'pr') && action === 'comment')
        hits.add('gh-comment');
      if (group === 'label') hits.add('gh-label');
      if (group === 'api') {
        const rule = apiWriteRule(words.slice(1));
        if (rule) hits.add(rule);
      }
    }
    if (executable === 'git') {
      // Git global options precede the subcommand; skip their values.
      while (words[0]?.startsWith('-')) {
        const option = words.shift();
        // A different repository or Git config can change the push destination.
        currentBranch = undefined;
        if (['-C', '-c', '--git-dir', '--work-tree'].includes(option ?? ''))
          words.shift();
      }
      const subcommand = words.shift();
      if (['checkout', 'switch', 'config'].includes(subcommand ?? ''))
        currentBranch = undefined;
      if (subcommand === 'push') {
        const positional: string[] = [];
        for (let i = 0; i < words.length; i++) {
          const w = words[i]!;
          if (
            [
              '--repo',
              '--receive-pack',
              '--exec',
              '-o',
              '--push-option',
            ].includes(w)
          ) {
            i++;
            continue;
          }
          if (!w.startsWith('-')) positional.push(w);
        }
        const refs = words.some(
          (w) => w === '--repo' || w.startsWith('--repo='),
        )
          ? positional
          : positional.slice(1);
        if (
          words.includes('--all') ||
          words.includes('--mirror') ||
          refs.includes(':') ||
          (refs.length === 0 &&
            (currentBranch === undefined || currentBranch === defaultBranch)) ||
          refs.some((ref) => {
            const target = ref.replace(/^\+/, '').split(':').pop()!;
            return (
              target === defaultBranch ||
              target === `refs/heads/${defaultBranch}` ||
              (target === 'HEAD' &&
                (currentBranch === undefined ||
                  currentBranch === defaultBranch))
            );
          })
        )
          hits.add('push-default-branch');
      }
    }
    // Shell -c wrappers are common in tool calls; inspect their command argument.
    if (['sh', 'bash', 'zsh'].includes(executable ?? '')) {
      const index = words.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
      if (index >= 0 && words[index + 1])
        for (const rule of policyRules(
          words[index + 1]!,
          defaultBranch,
          currentBranch,
        ))
          hits.add(rule);
    }
  }
  return hits;
}

export function commandInputs(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input)) return input.flatMap(commandInputs);
  return Object.entries(input).flatMap(([key, value]) =>
    /^(cmd|command|script)$/i.test(key) && typeof value === 'string'
      ? [value]
      : typeof value === 'object'
        ? commandInputs(value)
        : [],
  );
}

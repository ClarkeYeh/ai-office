import {
  createRedactor as createTextRedactor,
  summarize,
} from '@ai-office/redaction';
import type { RawAgentOutput } from '../../ports/runtime-events.js';
import type {
  ActivityMeta,
  PolicyHit,
  Redactor,
} from '../../ports/services.js';
import { commandInputs, policyRules } from './policy.js';

export interface RedactorOptions {
  defaultBranch: string;
  /** Fresh worktree branch context; omit when unknown (implicit pushes then hit). */
  currentBranch?: string;
  preservedRepoUrls?: readonly string[];
}

const categories: Record<string, ActivityMeta['category']> = {
  read: 'read',
  read_file: 'read',
  glob: 'read',
  grep: 'read',
  edit: 'edit',
  write: 'edit',
  write_file: 'edit',
  apply_patch: 'edit',
  bash: 'shell',
  shell: 'shell',
  exec_command: 'shell',
  run_command: 'shell',
  git: 'git',
  web: 'network',
  webfetch: 'network',
  fetch: 'network',
  orca: 'orca',
};
function metadata(value: unknown): { length: number; hash: string } {
  // Shared pure-JS hashing; undefined is an absent input, equivalent to empty text.
  const normalized = value === undefined ? '' : value;
  const serialized = JSON.stringify(normalized);
  if (serialized === undefined)
    throw new TypeError('Value is not JSON serializable');
  // Hash JSON encoding even for strings: transcript text resembling an existing
  // redaction summary must not be able to supply its own digest or byte count.
  const summary = summarize(serialized);
  const match = /^<redacted length=(\d+) sha256=([a-f0-9]{64})>$/.exec(
    summary,
  )!;
  return {
    length: new TextEncoder().encode(
      typeof normalized === 'string' ? normalized : serialized,
    ).length,
    hash: match[2]!,
  };
}

export function createRedactor(options: RedactorOptions): Redactor {
  if (!options.defaultBranch.trim())
    throw new TypeError('Expected a default branch');
  const text = createTextRedactor({
    preservedRepoUrls: options.preservedRepoUrls ?? [],
  });
  function mask(value: unknown): unknown {
    if (typeof value === 'string') return text.maskText(value);
    if (Array.isArray(value)) return value.map(mask);
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => {
        // Delegate secret-field classification to the shared library, but do not
        // use its fixture body summarization for structured artifacts (§20).
        const probe = text.sanitize({ [key]: 'probe' }) as Record<
          string,
          unknown
        >;
        return [
          text.maskText(key),
          Object.values(probe)[0] === '<redacted>' && child !== null
            ? '<redacted>'
            : mask(child),
        ] as const;
      });
      if (new Set(entries.map(([key]) => key)).size !== entries.length)
        throw new Error('Redacted key collision');
      return Object.fromEntries(entries);
    }
    return value;
  }
  return {
    maskSecrets<T>(value: T): T {
      return mask(value) as T;
    },
    toActivity(output: RawAgentOutput) {
      const activity: ActivityMeta[] = [];
      const rules = new Set<PolicyHit['rule']>();
      const paired = new Set<number>();
      for (const block of output.blocks) {
        if (block.type !== 'tool_use') continue;
        const tool = block.name.toLowerCase();
        const category = Object.hasOwn(categories, tool)
          ? categories[tool]!
          : 'other';
        const resultIndex = output.blocks.findIndex(
          (candidate, index) =>
            !paired.has(index) &&
            candidate.type === 'tool_result' &&
            candidate.toolUseId === block.id,
        );
        const result = output.blocks[resultIndex];
        if (resultIndex >= 0) paired.add(resultIndex);
        const input = metadata(block.input);
        activity.push({
          messageId: output.messageId,
          ...(category !== 'other' ? { tool } : {}),
          category,
          inputLen: input.length,
          inputHash: input.hash,
          outputLen:
            result?.type === 'tool_result' ? metadata(result.output).length : 0,
          ...(result?.type === 'tool_result' && result.ok !== undefined
            ? { ok: result.ok }
            : {}),
          ...(result?.type === 'tool_result' && result.durationMs !== undefined
            ? { durationMs: Math.floor(result.durationMs) }
            : {}),
        });
        for (const source of commandInputs(block.input))
          for (const rule of policyRules(
            source,
            options.defaultBranch,
            options.currentBranch,
          ))
            rules.add(rule);
      }
      output.blocks.forEach((block, index) => {
        if (block.type === 'tool_use' || paired.has(index)) return;
        activity.push({
          messageId: output.messageId,
          category: 'other',
          inputLen: 0,
          inputHash: metadata('').hash,
          outputLen: metadata(block.type === 'text' ? block.text : block.output)
            .length,
          ...(block.type === 'tool_result' && block.ok !== undefined
            ? { ok: block.ok }
            : {}),
          ...(block.type === 'tool_result' && block.durationMs !== undefined
            ? { durationMs: Math.floor(block.durationMs) }
            : {}),
        });
      });
      return {
        activity,
        policyHits: [...rules].map((rule) => ({
          rule,
          severity:
            rule === 'gh-comment' || rule === 'gh-label'
              ? ('medium' as const)
              : ('high' as const),
          messageId: output.messageId,
        })),
      };
    },
  };
}

/** Composition root supplies repository URL preservation explicitly. */
export function createRedactorFactory(
  options: {
    preservedRepoUrls?: readonly string[];
  } = {},
): import('../../ports/services.js').RedactorFactory {
  return {
    forAttempt(context) {
      return createRedactor({
        defaultBranch: context.defaultBranch,
        ...(context.currentBranch === null
          ? {}
          : { currentBranch: context.currentBranch }),
        ...(options.preservedRepoUrls === undefined
          ? {}
          : { preservedRepoUrls: options.preservedRepoUrls }),
      });
    },
  };
}

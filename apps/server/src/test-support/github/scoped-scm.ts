import type { ScmPort } from '../../ports/scm.js';
import { assertRunId } from './safety.js';
import { githubBranches } from './branch-namespace.js';

/**
 * Engine IDs are workflow ULIDs, not test markers. Adapt only test metadata;
 * retain real bodies/hashes/URLs and let T7 guard and ledger every HTTP write.
 */
export function scopeGithubScm(
  scm: ScmPort,
  runId: string,
  shortId?: string,
): ScmPort {
  assertRunId(runId);
  const branches = githubBranches(runId, shortId);
  const prefix = `t${runId}:`;
  const command = (id: string) => (id.startsWith(prefix) ? id : prefix + id);
  const body = (text: string) =>
    text.replace(
      /<!-- ai-office:cmd=([a-zA-Z0-9:_/-]+) -->/g,
      (_, id: string) => `<!-- ai-office:cmd=${command(id)} -->`,
    );
  const titlePrefix = `[aio-test ${runId}] `;
  const title = (text: string) =>
    text.startsWith(titlePrefix) ? text : titlePrefix + text;
  const overrides: Partial<ScmPort> = {
    ensureBranch: (repo, name, from, c) =>
      scm.ensureBranch(repo, branches.remote(name), branches.remote(from), c),
    deleteBranch: (repo, name) => scm.deleteBranch(repo, branches.remote(name)),
    compareBranch: (repo, base, head) =>
      scm.compareBranch(repo, branches.remote(base), branches.remote(head)),
    getPR: async (ref) => {
      const result = await scm.getPR(ref);
      return { ...result, base: branches.logical(result.base) };
    },
    createIssue: (repo, draft, c) =>
      scm.createIssue(
        repo,
        { ...draft, title: title(draft.title), body: body(draft.body) },
        { ...c, commandId: command(c.commandId) },
      ),
    openPR: (repo, draft, c) =>
      scm.openPR(
        repo,
        {
          ...draft,
          head: branches.remote(draft.head),
          base: branches.remote(draft.base),
          title: title(draft.title),
          body: body(draft.body),
        },
        { ...c, commandId: command(c.commandId) },
      ),
    comment: (ref, text, c) =>
      scm.comment(ref, body(text), { ...c, commandId: command(c.commandId) }),
    updateIssue: (ref, patch) =>
      scm.updateIssue(ref, {
        ...patch,
        ...(patch.title === undefined ? {} : { title: title(patch.title) }),
        ...(patch.body === undefined ? {} : { body: body(patch.body) }),
      }),
    updatePR: (ref, patch) =>
      scm.updatePR(ref, {
        ...patch,
        ...(patch.title === undefined ? {} : { title: title(patch.title) }),
        ...(patch.body === undefined ? {} : { body: body(patch.body) }),
      }),
    findByMarker: (repo, id, hint) => scm.findByMarker(repo, command(id), hint),
    poll: async (repo, cursor) => {
      const result = await scm.poll(repo, cursor);
      return {
        ...result,
        events: result.events.map((event) =>
          event.type === 'branch.head_changed'
            ? { ...event, branch: branches.logical(event.branch) }
            : event.type === 'pr.state'
              ? {
                  ...event,
                  head: branches.logical(event.head),
                  base: branches.logical(event.base),
                }
              : event.type === 'object.duplicate' &&
                  event.commandId.startsWith(prefix)
                ? { ...event, commandId: event.commandId.slice(prefix.length) }
                : event,
        ),
      };
    },
  };
  return new Proxy(scm, {
    get(target, key) {
      const override = Reflect.get(overrides, key) as unknown;
      if (override !== undefined) return override;
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

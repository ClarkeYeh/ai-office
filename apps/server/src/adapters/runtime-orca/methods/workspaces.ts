import { stat } from 'node:fs/promises';
import { isAbsolute, resolve, dirname } from 'node:path';
import { z } from 'zod';
import type { RuntimePort, PreparedWorkspace } from '../../../ports/runtime.js';
import type { WorkspaceRef } from '../../../ports/refs.js';
import { PortError } from '../../../ports/errors.js';
import { workspaceRef } from '../refs.js';
import { guard } from '../errors.js';
import { Context, hasMarker, marker, digest, object, text } from './context.js';

export const Worktree = z.looseObject({
  id: text,
  path: text,
  branch: z.string().nullable(),
  head: z.string().optional(),
  repoId: text,
  comment: z.string().nullish(),
  displayName: z.string().optional(),
  isMainWorktree: z.boolean().optional(),
});
export type Worktree = z.infer<typeof Worktree>;
const branch = (w: Worktree) => w.branch?.replace(/^refs\/heads\//, '') ?? '';
const base = (w: Worktree) =>
  /(?:^|\s)base:([a-f0-9]{40})(?:\s|$)/.exec(w.comment ?? '')?.[1];
const prepared = (w: Worktree): PreparedWorkspace => ({
  workspace: workspaceRef(w.id),
  path: w.path,
  ...(base(w) ? { baseSha: base(w)! } : {}),
});
export class Workspaces {
  constructor(readonly c: Context) {}
  async show(id: string): Promise<Worktree | null> {
    try {
      return (
        await this.c.call(
          ['worktree', 'show', '--worktree', `id:${id}`],
          z.looseObject({ worktree: Worktree }),
        )
      ).worktree;
    } catch (e) {
      if (
        e instanceof PortError &&
        // Orca 1.4.259 reports a removed worktree as selector_not_found (D9).
        ['worktree_not_found', 'not_found', 'selector_not_found'].includes(
          e.code,
        )
      )
        return null;
      throw e;
    }
  }
  async find(req: Parameters<RuntimePort['findWorkspace']>[0]) {
    const { worktrees } = await this.c.call(
      ['worktree', 'list', '--repo', `id:${req.repo.orcaRepoId}`],
      z.looseObject({ worktrees: z.array(Worktree) }),
    );
    const w = worktrees.find((w) => w.displayName === req.name);
    if (!w) return null;
    if (!hasMarker(w.comment ?? '', req.commandId))
      throw guard('workspace_marker_mismatch');
    if (!base(w) || !isAbsolute(w.path))
      throw guard('workspace_receipt_invalid');
    return prepared(w);
  }
  async unoccupied(repo: string, name: string) {
    if (
      (await this.c.options.git.worktrees(repo)).some(
        (w) => w.branch?.replace(/^refs\/heads\//, '') === name,
      )
    )
      throw guard('branch_in_use');
  }
  async prepare(
    req: Parameters<RuntimePort['prepareWorkspace']>[0],
  ): Promise<PreparedWorkspace> {
    this.c.check(req.correlation.commandId, req);
    const found = await this.find({
      ...req,
      commandId: req.correlation.commandId,
    });
    if (found) {
      const actual = (
        await this.c.options.git.worktrees(req.repo.localPath)
      ).find((w) => w.path === found.path);
      if (actual?.branch !== 'refs/heads/' + req.branch) {
        const stale = await this.show(found.workspace);
        if (stale && found.baseSha)
          await this.removeCreated(stale, req.repo.localPath, found.baseSha);
        throw guard('branch_suffixed');
      }
      if (req.baseSha && req.baseSha !== found.baseSha)
        throw guard('workspace_base_mismatch');
      this.c.options.state.write(`orca:prepared:${found.workspace}`, {
        commandId: req.correlation.commandId,
        branch: req.branch,
      });
      return found;
    }
    const git = this.c.options.git,
      repo = req.repo.localPath;
    const fetch =
      req.fetchBranch ??
      (req.checkoutExisting
        ? req.branch
        : req.baseBranch.startsWith('origin/')
          ? req.baseBranch.slice(7)
          : undefined);
    if (!fetch) throw guard('base_fetch_required');
    await git.fetch(repo, fetch);
    const sha =
      req.baseSha ??
      (/^[a-f0-9]{40}$/.test(req.baseBranch)
        ? req.baseBranch
        : req.baseBranch === `origin/${fetch}`
          ? await git.revParse(repo, `refs/remotes/origin/${fetch}`)
          : '');
    if (!/^[a-f0-9]{40}$/.test(sha)) throw guard('invalid_workspace_base');
    if (!(await git.isAncestor(repo, sha, `refs/remotes/origin/${fetch}`)))
      throw guard('base_not_fetched');
    await this.unoccupied(repo, req.branch);
    const local = await git.localBranch(repo, req.branch);
    if (req.checkoutExisting) {
      if (fetch !== req.branch) throw guard('checkout_fetch_mismatch');
      if (local) await git.resetBranch(repo, req.branch, sha);
      else await git.createBranch(repo, req.branch, sha);
    } else if (local) throw guard('branch_exists');
    const create = async (name: string) => {
      const receipt = await this.c.call(
        [
          'worktree',
          'create',
          '--repo',
          `id:${req.repo.orcaRepoId}`,
          '--name',
          req.name,
          '--branch',
          name,
          '--base-branch',
          sha,
          '--no-parent',
          '--setup',
          'skip',
          '--comment',
          `${marker(req.correlation.commandId)} base:${sha}`,
        ],
        z.looseObject({ worktree: Worktree }),
      );
      if (
        !isAbsolute(receipt.worktree.path) ||
        receipt.worktree.repoId !== req.repo.orcaRepoId ||
        !hasMarker(receipt.worktree.comment ?? '', req.correlation.commandId)
      )
        throw guard('workspace_receipt_invalid');
      const w = await this.show(receipt.worktree.id);
      if (
        !w ||
        w.path !== receipt.worktree.path ||
        w.branch !== receipt.worktree.branch
      )
        throw guard('workspace_receipt_changed');
      return w;
    };
    let w = await create(req.branch);
    if (branch(w) !== req.branch) {
      await this.removeCreated(w, repo, sha);
      if (!req.checkoutExisting) throw guard('branch_suffixed');
      await this.unoccupied(repo, req.branch);
      const temp = `aio-tmp-${digest(req.correlation.commandId).slice(0, 20)}`;
      if (await git.localBranch(repo, temp)) throw guard('branch_exists');
      w = await create(temp);
      if (branch(w) !== temp) {
        await this.removeCreated(w, repo, sha);
        throw guard('branch_suffixed');
      }
      await git.checkoutBranch(w.path, req.branch, sha);
      await git.deleteCreatedBranch(repo, temp, sha);
      // Orca's catalog can retain the old branch; verify actual git, never infer a path.
    }
    if ((await git.revParse(w.path, 'HEAD')) !== sha) {
      throw guard('workspace_head_mismatch');
    }
    const actual = (await git.worktrees(repo)).find((t) => t.path === w.path);
    if (actual?.branch !== `refs/heads/${req.branch}`)
      throw guard('branch_suffixed');
    const result = { ...prepared(w), baseSha: sha };
    this.c.options.state.write(`orca:prepared:${result.workspace}`, {
      commandId: req.correlation.commandId,
      branch: req.branch,
    });
    this.c.save(req.correlation.commandId, {
      kind: 'runtime.prepareWorkspace',
      result,
    });
    return result;
  }
  async removeCreated(w: Worktree, repo: string, sha: string) {
    if (!/(?:^|\s)aio:\S+/.test(w.comment ?? '') || w.isMainWorktree)
      throw guard('workspace_not_managed');
    if (
      (await this.c.options.git.revParse(w.path, 'HEAD')) !== sha ||
      (await this.c.options.git.status(w.path)).length
    )
      throw guard('unpushed_commits');
    const name = branch(w);
    const branchSha = name
      ? await this.c.options.git.localBranch(repo, name)
      : null;
    if (branchSha && branchSha !== sha) throw guard('unpushed_commits');
    await this.c.call(['worktree', 'rm', '--worktree', `id:${w.id}`], object);
    if (name)
      await this.c.options.git.deleteCreatedBranch(
        repo,
        name,
        branchSha ?? sha,
      );
  }
  async preparedHere(id: string): Promise<boolean> {
    const proof = z
      .object({ commandId: text })
      .safeParse(this.c.options.state.read(`orca:prepared:${id}`));
    if (!proof.success) return false;
    const w = await this.show(id);
    return w !== null && hasMarker(w.comment ?? '', proof.data.commandId);
  }
  async dispose(id: WorkspaceRef) {
    const w = await this.show(id);
    if (!w) return;
    if (!/(?:^|\s)aio:\S+/.test(w.comment ?? '') || w.isMainWorktree)
      throw guard('workspace_not_managed');
    const git = this.c.options.git;
    if ((await git.status(w.path)).length) throw guard('workspace_dirty');
    const proof = z
      .object({ commandId: text, branch: text.optional() })
      .safeParse(this.c.options.state.read(`orca:prepared:${id}`));
    const name =
      proof.success && hasMarker(w.comment ?? '', proof.data.commandId)
        ? (proof.data.branch ?? branch(w))
        : branch(w);
    const tip = await git.revParse(w.path, 'HEAD');
    const repo = Object.values(this.c.sessions()).find(
      (r) => r.orcaRepoId === w.repoId,
    )?.localPath;
    if (!repo) throw guard('workspace_repo_unknown');
    const branchSha = name ? await git.localBranch(repo, name) : null;
    if (tip !== base(w) || (branchSha && branchSha !== base(w)))
      await git.fetch(repo);
    if (tip !== base(w) && !(await git.originContains(repo, tip)))
      throw guard('workspace_unpushed');
    if (
      branchSha &&
      branchSha !== base(w) &&
      !(await git.originContains(repo, branchSha))
    )
      throw guard('workspace_unpushed');
    await this.c.call(['worktree', 'rm', '--worktree', `id:${id}`], object);
    if (name && branchSha) await git.deleteCreatedBranch(repo, name, branchSha);
  }

  async inspect(id: WorkspaceRef) {
    const w = await this.show(id);
    if (!w) return { clean: false, changedFiles: [] };
    try {
      const changedFiles = await this.c.options.git.status(w.path);
      return { clean: changedFiles.length === 0, changedFiles };
    } catch (error) {
      if (error instanceof PortError && error.code === 'git_command_failed') {
        try {
          await stat(w.path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT')
            return { clean: false, changedFiles: [] };
        }
      }
      throw error;
    }
  }
  async inspectRepo(path: string) {
    const { repos } = await this.c.call(
      ['repo', 'list'],
      z.looseObject({
        repos: z.array(z.looseObject({ id: text, path: text })),
      }),
    );
    const git = this.c.options.git;
    try {
      const d = await git.directories(path);
      const originUrl = await git.originUrl(path).catch(() => null);
      return {
        isGitMainWorktree:
          resolve(d.topLevel) === resolve(path) &&
          dirname(resolve(path, d.commonDir)) === resolve(path),
        originUrl,
        runtimeRepoId:
          repos.find((r) => resolve(r.path) === resolve(path))?.id ?? null,
      };
    } catch (e) {
      if (!(e instanceof PortError) || e.code !== 'git_command_failed') throw e;
      return { isGitMainWorktree: false, originUrl: null, runtimeRepoId: null };
    }
  }
}

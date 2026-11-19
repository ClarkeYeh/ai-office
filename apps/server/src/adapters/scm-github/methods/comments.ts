import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { ScmPort } from '../../../ports/scm.js';
import { guard } from '../policy/endpoints.js';
import { emptySchema } from '../schemas/common.js';
import { repoParams, type ScmGithubDeps } from './deps.js';
import { commandMarker, createPendingOperation } from './marker.js';
const commentSchema = z.looseObject({
  id: z.number().int().positive().safe(),
  html_url: z.string().url(),
});
const deleteSchema = commentSchema.extend({
  body: z.string().nullable(),
  user: z.looseObject({ login: z.string() }),
  issue_url: z.string().url(),
});
export function createCommentMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'comment' | 'deleteComment'> {
  const pending = createPendingOperation(deps);
  return {
    async comment(ref, body, c) {
      await pending(ref.repo, c.commandId, 'comment', async () => {
        const { data } = await deps.http.request(
          'comments.create',
          {
            ...repoParams(ref.repo),
            number: ref.number,
            body: { body: `${body}\n\n${commandMarker(c.commandId)}` },
          },
          { schema: commentSchema },
        );
        return {
          ...ref,
          kind: 'comment',
          commentId: String(data.id),
          url: data.html_url,
        };
      });
    },
    async deleteComment(target, commentId) {
      deps.repoAllowlist.assert(target.repo, true);
      if (
        !/^[1-9]\d*$/.test(commentId) ||
        !Number.isSafeInteger(Number(commentId))
      )
        guard('invalid_comment_id');
      const params = { ...repoParams(target.repo), id: Number(commentId) };
      const viewer = await deps.viewerLogin();
      try {
        const { data } = await deps.http.request('comments.get', params, {
          schema: deleteSchema,
          conditional: false,
        });
        const expected = `https://api.github.com/repos/${target.repo.owner}/${target.repo.name}/issues/${target.number}`;
        const commandId = /<!-- ai-office:cmd=([^\s<>]+) -->/.exec(
          data.body ?? '',
        )?.[1];
        if (data.issue_url !== expected || data.id !== params.id)
          guard('comment_delete_not_allowed');
        await deps.http.request('comments.delete', params, {
          schema: emptySchema,
          safety: {
            viewer,
            author: data.user.login,
            body: data.body ?? '',
            ...(commandId ? { commandId } : {}),
          },
        });
      } catch (error) {
        if (!(error instanceof PortError) || error.code !== 'not_found')
          throw error;
      }
    },
  };
}

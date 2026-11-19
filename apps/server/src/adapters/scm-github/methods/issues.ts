import { z } from 'zod';
import { bodyHash } from '@ai-office/domain';
import type { ScmPort } from '../../../ports/scm.js';
import { emptySchema } from '../schemas/common.js';
import { repoParams, type ScmGithubDeps } from './deps.js';
import { commandMarker, createPendingOperation } from './marker.js';

const createdIssue = z.looseObject({
  number: z.number().int().positive(),
  html_url: z.string().url(),
});
const issueSchema = z.looseObject({
  body: z.string().nullable(),
  updated_at: z.string(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
});
export function createIssueMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'createIssue' | 'getIssue' | 'updateIssue'> {
  const pending = createPendingOperation(deps);
  return {
    async createIssue(repo, draft, c) {
      const result = await pending(repo, c.commandId, 'issue', async () => {
        const { data } = await deps.http.request(
          'issues.create',
          {
            ...repoParams(repo),
            body: {
              ...draft,
              body: `${draft.body}\n\n${commandMarker(c.commandId)}`,
            },
          },
          { schema: createdIssue },
        );
        return { repo, number: data.number, url: data.html_url, kind: 'issue' };
      });
      return { repo, number: result.number, url: result.url };
    },
    async getIssue(ref) {
      const { data } = await deps.http.request(
        'issues.get',
        { ...repoParams(ref.repo), number: ref.number },
        { schema: issueSchema, conditional: false },
      );
      const body = data.body ?? '';
      return {
        body,
        bodyHash: bodyHash(body),
        updatedAt: data.updated_at,
        labels: data.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      };
    },
    async updateIssue(ref, patch) {
      await deps.http.request(
        'issues.update',
        { ...repoParams(ref.repo), number: ref.number, body: patch },
        { schema: emptySchema },
      );
    },
  };
}

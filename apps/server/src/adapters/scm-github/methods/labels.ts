import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { GithubError } from '../errors.js';
import { emptySchema } from '../schemas/common.js';
import { repoParams, type ScmGithubDeps } from './deps.js';
const labelsSchema = z.array(z.looseObject({ name: z.string() }));
export function createLabelMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'ensureLabels' | 'setLabels'> {
  return {
    async ensureLabels(repo, labels) {
      deps.repoAllowlist.assert(repo, true);
      const existing = new Set(
        (
          await deps.http.paginate('labels.list', repoParams(repo), {
            schema: labelsSchema,
            conditional: true,
          })
        ).map((label) => label.name.toLowerCase()),
      );
      for (const label of labels) {
        if (existing.has(label.name.toLowerCase())) continue;
        try {
          await deps.http.request(
            'labels.create',
            { ...repoParams(repo), body: label },
            { schema: emptySchema },
          );
        } catch (error) {
          if (
            !(error instanceof PortError) ||
            !(error as GithubError).alreadyExists
          )
            throw error;
        }
        existing.add(label.name.toLowerCase());
      }
    },
    async setLabels(ref, labels) {
      await deps.http.request(
        'issues.labels',
        { ...repoParams(ref.repo), number: ref.number, body: { labels } },
        { schema: emptySchema },
      );
    },
  };
}

/**
 * M5-T8 reviewer-scope fallback (M5_PLAN §2.2.3): the isolated home's
 * `templates/feature-to-pr.yaml` is the built-in template with one extra
 * sentence in `roles.integrator.scope`. Role scope reaches only that role's
 * own spec (spec-builder `roleSection`), so workers never see it. Write the
 * file before the backend's first start: built-ins are copied only when absent.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { TEMPLATE_ID } from './m5-mainline.js';

export const INTEGRATOR_SCOPE_FALLBACK =
  "When an acceptance criterion requires content that only the work item's worker may write, send the pull request back with rework-request stating what must change; never edit that content yourself.";

/**
 * The built-in `feature-to-pr.yaml` source, read by path like the M1 gates
 * acceptance test (only template-fs may import `@ai-office/templates`). The
 * depth is the same from `src/` and `dist/`.
 */
export const builtinTemplateSource = (): Promise<string> =>
  readFile(
    join(
      import.meta.dirname,
      `../../../../../../packages/templates/${TEMPLATE_ID}.yaml`,
    ),
    'utf8',
  );

/** The override YAML: identical to `source` except the integrator scope. */
export function withIntegratorFallback(source: string): string {
  const document = parseDocument(source);
  const path = ['roles', 'integrator', 'scope'];
  const scope = document.getIn(path);
  if (typeof scope !== 'string')
    throw new Error('Template has no integrator scope');
  document.setIn(path, `${scope} ${INTEGRATOR_SCOPE_FALLBACK}`);
  return document.toString();
}

/** File name → YAML for the isolated home's `templates/` directory. */
export async function mainlineTemplates(): Promise<Record<string, string>> {
  return {
    [`${TEMPLATE_ID}.yaml`]: withIntegratorFallback(
      await builtinTemplateSource(),
    ),
  };
}

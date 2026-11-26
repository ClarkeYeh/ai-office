/**
 * M5-T8 scenario bindings (M5_PLAN §2.5): one `m5-mainline` text, two SCM
 * worlds. T12 runs production against the spike; T11b runs `--dev --runtime
 * orca` with `testOnly.scm = scm-gitremote`, where Issues and PRs live in the
 * double's memory (PR numbers still come from the backend, so the `#pending`
 * nonce holds) and the final PR is merged by the double's explicit owner merge.
 */
import { mainlineTag, requirement, TEMPLATE_ID } from './m5-mainline.js';
import { mainlineTemplates } from './template.js';

export type MainlineWorld = 'github' | 'gitremote';

export interface MainlineRun {
  world: MainlineWorld;
  tag: string;
  templateId: typeof TEMPLATE_ID;
  requirement: string;
  /** Files for the isolated home's `templates/`, written before first start. */
  templates: Record<string, string>;
  /** `[budget] enforcement` in the isolated home's config. */
  enforcement: 'off';
  /** How the conclusion gate is approved (§2.2.4 first row). */
  conclusion: 'github-body-hash' | 'in-memory';
  /** Who merges the final PR; never the harness on GitHub. */
  finalPrMerge: 'owner-by-hand' | 'double-explicit';
}

export async function mainlineRun(
  world: MainlineWorld,
  now: Date,
): Promise<MainlineRun> {
  const tag = mainlineTag(now);
  return {
    world,
    tag,
    templateId: TEMPLATE_ID,
    requirement: requirement(tag),
    templates: await mainlineTemplates(),
    enforcement: 'off',
    conclusion: world === 'github' ? 'github-body-hash' : 'in-memory',
    finalPrMerge: world === 'github' ? 'owner-by-hand' : 'double-explicit',
  };
}

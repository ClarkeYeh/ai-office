import type { WorkflowTemplate } from '@ai-office/contracts/template';
import { t } from '../../../shared/lib/i18n/index.js';
import { PixelFrame } from '../../../shared/ui/index.js';
import styles from './templates.module.css';

export function TemplateView({ template }: { template: WorkflowTemplate }) {
  return (
    <div className={styles.grid}>
      <PixelFrame>
        <h2>{t('templates.stages')}</h2>
        <ol className={styles.stages}>
          {template.stages.map((stage) => (
            <li key={stage.id} className={styles.stage}>
              <h3>{t(`stage.${stage.kind}`)}</h3>
              {'timeouts' in stage && (
                <>
                  <p className={styles.intro}>{t('templates.timeout')}</p>
                  <dl className={styles.facts}>
                    {Object.entries(stage.timeouts).map(([key, value]) => (
                      <div key={key}>
                        <dt>
                          {t(
                            `templates.${key as 'roundMin' | 'stageMin' | 'itemMin'}`,
                          )}
                        </dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
              {stage.kind === 'implement' && (
                <>
                  <p>{t('templates.parallel', { count: stage.maxParallel })}</p>
                  <dl className={styles.facts}>
                    <dt>{t('templates.questionTimeoutMin')}</dt>
                    <dd>{stage.onCall.questionTimeoutMin}</dd>
                    <dt>{t('templates.reviewTimeoutMin')}</dt>
                    <dd>{stage.mergeQueue.reviewTimeoutMin}</dd>
                  </dl>
                </>
              )}
              {stage.kind === 'final-pr' && (
                <p>{t('templates.revisions', { count: stage.maxRevisions })}</p>
              )}
              {'gate' in stage && (
                <div
                  className={styles.gate}
                  data-testid={`template-gate-${stage.gate.id}`}
                >
                  <strong>{stage.gate.title}</strong>
                  <p>
                    {t(
                      stage.kind !== 'final-pr' && stage.gate.optional
                        ? 'templates.gateOptional'
                        : 'templates.gateRequired',
                    )}
                  </p>
                </div>
              )}
            </li>
          ))}
        </ol>
      </PixelFrame>
      <div className={styles.stack}>
        <PixelFrame>
          <h2>{t('templates.roles')}</h2>
          {Object.entries(template.roles).map(([name, role]) => (
            <section key={name} className={styles.role}>
              <h3>{name}</h3>
              <p>
                {t(
                  role.agent === 'codex'
                    ? 'workflows.codex'
                    : 'workflows.claude',
                )}{' '}
                ·{' '}
                {t(
                  role.effort
                    ? `workflows.${role.effort}`
                    : 'workflows.defaultEffort',
                )}
              </p>
              <p>{role.scope ?? t('templates.noScope')}</p>
            </section>
          ))}
        </PixelFrame>
        <PixelFrame>
          <h2>{t('templates.source')}</h2>
          <p>{t('templates.sourceUnknown')}</p>
          <p className={styles.intro}>{t('templates.edit')}</p>
          <p>
            {t('templates.branch', {
              branch: template.defaults.integrationBranch,
            })}
          </p>
          <p>{t('templates.reruns', { count: template.defaults.maxReruns })}</p>
        </PixelFrame>
      </div>
    </div>
  );
}

export function TemplateErrors({
  invalid,
}: {
  invalid: readonly {
    file: string;
    issues: readonly { path: string; message: string }[];
  }[];
}) {
  if (!invalid.length) return null;
  return (
    <PixelFrame data-testid="template-errors">
      <h2>{t('templates.invalid')}</h2>
      {invalid.map((entry, index) => (
        <section className={styles.errors} key={`${entry.file}-${index}`}>
          <h3>{entry.file}</h3>
          <ul>
            {entry.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.path}</code>
                {': '}
                {issue.message}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p>{t('templates.edit')}</p>
    </PixelFrame>
  );
}

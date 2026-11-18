import { useState, type ReactNode } from 'react';
import type {
  WorkflowTemplate,
  RoleOverrides,
} from '@ai-office/contracts/template';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, Link, PixelFrame } from '../../../shared/ui/index.js';
import styles from './workflows.module.css';

export interface StartDraft {
  templateId: string;
  repoId: string;
  requirement: string;
  roleOverrides: RoleOverrides;
  gateToggles: Record<string, boolean>;
  acknowledgeUnverifiedRuntime: boolean;
}
export interface StartFormProps {
  templates: WorkflowTemplate[];
  repos: { id: string; name: string }[];
  initialTemplateId: string;
  busy: boolean;
  pending: boolean;
  needsAcknowledgement: boolean;
  notice: ReactNode;
  onStart: (draft: StartDraft) => void;
  onRefresh: () => void;
}
export function StartForm(props: StartFormProps) {
  const [templateId, setTemplateId] = useState(props.initialTemplateId);
  const [repoId, setRepoId] = useState(props.repos[0]?.id ?? '');
  const [requirement, setRequirement] = useState('');
  const [roles, setRoles] = useState<RoleOverrides>({});
  const [gates, setGates] = useState<Record<string, boolean>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const template = props.templates.find((value) => value.id === templateId);
  const validRepo = props.repos.some((repo) => repo.id === repoId);
  const canStart =
    template &&
    validRepo &&
    requirement.trim() &&
    !props.busy &&
    !props.pending &&
    (!props.needsAcknowledgement || acknowledged);
  return (
    <form
      className={styles.page}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canStart) return;
        props.onStart({
          templateId,
          repoId,
          requirement: requirement.trim(),
          roleOverrides: roles,
          gateToggles: gates,
          acknowledgeUnverifiedRuntime: acknowledged,
        });
      }}
    >
      <p className={styles.intro}>{t('workflows.intro')}</p>
      {props.busy && (
        <Banner data-testid="workflow-slot-busy">{t('workflows.busy')}</Banner>
      )}
      {props.notice}
      <div className={styles.grid}>
        <PixelFrame className={styles.stack}>
          <h2>{t('workflows.start')}</h2>
          <label className={styles.field}>
            {t('workflows.requirement')}
            <textarea
              className={styles.input}
              data-testid="workflow-requirement"
              aria-label={t('workflows.requirement')}
              aria-describedby="requirement-hint"
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              required
              disabled={props.pending}
            />
          </label>
          <p id="requirement-hint" className={styles.intro}>
            {t('workflows.requirementHint')}
          </p>
          <label className={styles.field}>
            {t('workflows.repo')}
            <select
              className={styles.input}
              data-testid="workflow-repo"
              aria-label={t('workflows.repo')}
              value={repoId}
              onChange={(event) => setRepoId(event.target.value)}
              required
              disabled={props.pending}
            >
              <option value="">{t('workflows.choose')}</option>
              {props.repos.map((repo) => (
                <option value={repo.id} key={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
          {!props.repos.length && <p>{t('workflows.noRepos')}</p>}
          <Link
            href="/repos"
            data-testid="workflow-repos-link"
            aria-label={t('app.repos')}
          >
            {t('app.repos')}
          </Link>
          <label className={styles.field}>
            {t('workflows.template')}
            <select
              className={styles.input}
              data-testid="workflow-template"
              aria-label={t('workflows.template')}
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value);
                setRoles({});
                setGates({});
              }}
              required
              disabled={props.pending}
            >
              <option value="">{t('workflows.choose')}</option>
              {props.templates.map((value) => (
                <option value={value.id} key={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
          {!props.templates.length && <p>{t('workflows.noTemplates')}</p>}
          <Link
            href={
              template
                ? `/templates/${encodeURIComponent(template.id)}`
                : '/templates'
            }
            data-testid="workflow-template-link"
            aria-label={t('templates.view')}
          >
            {t('templates.view')}
          </Link>
        </PixelFrame>
        <div className={styles.stack}>
          {template && (
            <>
              <PixelFrame>
                <h2>{t('workflows.roles')}</h2>
                <table className={styles.roles}>
                  <thead>
                    <tr>
                      <th>{t('workflows.role')}</th>
                      <th>{t('workflows.vendor')}</th>
                      <th>{t('workflows.effort')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(template.roles).map(([name, defaults]) => {
                      const role = roles[name] ?? defaults;
                      return (
                        <tr key={name}>
                          <th scope="row">{name}</th>
                          <td>
                            <select
                              className={styles.input}
                              aria-label={`${name} ${t('workflows.vendor')}`}
                              data-testid={`role-vendor-${name}`}
                              value={role.agent}
                              disabled={props.pending}
                              onChange={(event) =>
                                setRoles((previous) => ({
                                  ...previous,
                                  [name]: {
                                    ...(role.effort
                                      ? { effort: role.effort }
                                      : {}),
                                    agent: event.target.value as
                                      'claude-code' | 'codex',
                                  },
                                }))
                              }
                            >
                              <option value="claude-code">
                                {t('workflows.claude')}
                              </option>
                              <option value="codex">
                                {t('workflows.codex')}
                              </option>
                              <option disabled value="gemini">
                                {t('workflows.gemini')}
                              </option>
                            </select>
                          </td>
                          <td>
                            <select
                              className={styles.input}
                              aria-label={`${name} ${t('workflows.effort')}`}
                              data-testid={`role-effort-${name}`}
                              value={role.effort ?? ''}
                              disabled={props.pending}
                              onChange={(event) => {
                                const effort = event.target.value as
                                  'low' | 'medium' | 'high' | '';
                                setRoles((previous) => ({
                                  ...previous,
                                  [name]: {
                                    agent: role.agent,
                                    ...(effort ? { effort } : {}),
                                  },
                                }));
                              }}
                            >
                              <option value="">
                                {defaults.effort
                                  ? t('workflows.templateEffort', {
                                      effort: t(`workflows.${defaults.effort}`),
                                    })
                                  : t('workflows.defaultEffort')}
                              </option>
                              {(['low', 'medium', 'high'] as const).map(
                                (value) => (
                                  <option key={value} value={value}>
                                    {t(`workflows.${value}`)}
                                  </option>
                                ),
                              )}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </PixelFrame>
              <PixelFrame>
                <h2>{t('workflows.gates')}</h2>
                {template.stages.flatMap((stage) =>
                  'gate' in stage
                    ? [
                        <label className={styles.toggle} key={stage.id}>
                          <input
                            type="checkbox"
                            data-testid={`gate-toggle-${stage.gate.id}`}
                            aria-label={stage.gate.title}
                            checked={gates[stage.gate.id] ?? true}
                            disabled={
                              props.pending ||
                              stage.kind === 'final-pr' ||
                              !stage.gate.optional
                            }
                            onChange={(event) =>
                              setGates((previous) => ({
                                ...previous,
                                [stage.gate.id]: event.target.checked,
                              }))
                            }
                          />
                          {stage.gate.title}
                          <small>
                            {t(
                              stage.kind !== 'final-pr' && stage.gate.optional
                                ? 'workflows.optional'
                                : 'workflows.locked',
                            )}
                          </small>
                        </label>,
                      ]
                    : [],
                )}
                <p className={styles.intro}>{t('workflows.gatesHint')}</p>
              </PixelFrame>
            </>
          )}
        </div>
      </div>
      {props.needsAcknowledgement && (
        <Banner tone="attention">
          <p>{t('workflows.unverified')}</p>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              data-testid="workflow-acknowledge"
              aria-label={t('workflows.acknowledge')}
              checked={acknowledged}
              disabled={props.pending}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {t('workflows.acknowledge')}
          </label>
        </Banner>
      )}
      <div className={styles.row}>
        <Button
          type="submit"
          variant="primary"
          data-testid="workflow-start"
          aria-label={t('workflows.start')}
          disabled={!canStart}
        >
          {t(props.pending ? 'workflows.pending' : 'workflows.start')}
        </Button>
        <Button
          data-testid="workflow-refresh"
          aria-label={t('workflows.refresh')}
          disabled={props.pending}
          onClick={props.onRefresh}
        >
          {t('workflows.refresh')}
        </Button>
      </div>
    </form>
  );
}

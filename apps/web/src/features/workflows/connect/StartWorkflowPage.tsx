import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiClient,
  type ApiResponse,
} from '../../../api/index.js';
import { useWebState } from '../../../realtime/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, useNavigation } from '../../../shared/ui/index.js';
import { TemplateErrors } from '../../templates/index.js';
import { StartForm, type StartDraft } from '../ui/StartForm.js';

type Setup = {
  templates: ApiResponse<'listTemplates'>;
  repos: ApiResponse<'listRepos'>;
};
export function StartWorkflowPage({ api }: { api: ApiClient }) {
  const { navigate } = useNavigation();
  const workflows = useWebState((state) => state.overview.workflows);
  const unverified = useWebState(
    (state) => state.overview.health?.runtime.verified === false,
  );
  const [data, setData] = useState<Setup | null>(null);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [serverBusy, setServerBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<'invalid' | 'failed' | null>(null);
  const [ackRequired, setAckRequired] = useState(false);
  const [invalid, setInvalid] = useState<
    ApiResponse<'listTemplates'>['invalid']
  >([]);
  useEffect(
    () =>
      setServerBusy(
        workflows.some((workflow) => workflow.status === 'running'),
      ),
    [workflows],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void Promise.all([
      api.listTemplates({ signal: controller.signal }),
      api.listRepos({ signal: controller.signal }),
      api.listWorkflows({ signal: controller.signal }),
    ]).then(
      ([templates, repos, current]) => {
        if (controller.signal.aborted) return;
        setData({ templates, repos });
        setServerBusy(
          current.workflows.some((workflow) => workflow.status === 'running'),
        );
        setInvalid(templates.invalid);
        setError(null);
        setLoading(false);
      },
      () => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [api, nonce]);
  async function start(draft: StartDraft) {
    if (submitting.current || loading || serverBusy) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.startWorkflow(draft);
      navigate(`/workflows/${encodeURIComponent(result.workflowId)}`);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        cause.code === 'workflow_slot_busy'
      )
        setServerBusy(true);
      else if (cause instanceof ApiError && cause.status === 428)
        setAckRequired(true);
      else if (cause instanceof ApiError && cause.status === 422) {
        setError('invalid');
        // Reload diagnostics from the typed template endpoint. Error.message is diagnostic,
        // not localized UI copy, and some servers do not include structured details.
        try {
          const result = await api.getTemplate(draft.templateId);
          setInvalid(result.invalid);
        } catch {
          /* The validation banner remains useful when diagnostics cannot load. */
        }
      } else setError('failed');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const refresh = () => setNonce((value) => value + 1);
  if (!data)
    return (
      <>
        <Banner tone={failed ? 'error' : 'info'}>
          {t(failed ? 'workflows.loadFailed' : 'workflows.loading')}
        </Banner>
        {failed && (
          <Button
            data-testid="workflow-refresh"
            aria-label={t('workflows.refresh')}
            onClick={refresh}
          >
            {t('workflows.refresh')}
          </Button>
        )}
      </>
    );
  const requested = new URLSearchParams(globalThis.location.search).get(
    'template',
  );
  const initialTemplateId =
    data.templates.valid.find((template) => template.id === requested)?.id ??
    data.templates.valid[0]?.id ??
    '';
  return (
    <StartForm
      templates={data.templates.valid}
      repos={data.repos.repos
        .filter((repo) => repo.status === 'registered')
        .map((repo) => ({
          id: repo.repoId,
          name: `${repo.github.owner}/${repo.github.name}`,
        }))}
      initialTemplateId={initialTemplateId}
      busy={serverBusy}
      pending={pending || loading || failed}
      needsAcknowledgement={ackRequired || unverified}
      onStart={(draft) => {
        void start(draft);
      }}
      onRefresh={refresh}
      notice={
        <>
          {loading && <Banner>{t('workflows.loading')}</Banner>}
          {failed && (
            <Banner tone="error">
              {t('workflows.loadFailed')}
              <Button
                data-testid="workflow-load-retry"
                aria-label={t('workflows.refresh')}
                onClick={refresh}
              >
                {t('workflows.refresh')}
              </Button>
            </Banner>
          )}
          {error && (
            <Banner tone="error" data-testid="workflow-error">
              {t(`workflows.${error}`)}
            </Banner>
          )}
          <TemplateErrors invalid={invalid} />
        </>
      }
    />
  );
}

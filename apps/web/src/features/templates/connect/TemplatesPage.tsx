import { useEffect, useState } from 'react';
import type { ApiClient, ApiResponse } from '../../../api/index.js';
import { t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, Link, PixelFrame } from '../../../shared/ui/index.js';
import { TemplateErrors, TemplateView } from '../ui/TemplateView.js';
import styles from '../ui/templates.module.css';

export function TemplatesPage({
  api,
  route,
}: {
  api: ApiClient;
  route: { params: Readonly<Record<string, string>> };
}) {
  const id = route.params.id;
  const [load, setLoad] = useState<{
    id: string | undefined;
    data?: ApiResponse<'listTemplates'>;
    failed?: boolean;
  }>({ id });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ id });
    const request = id
      ? api.getTemplate(id, { signal: controller.signal })
      : api.listTemplates({ signal: controller.signal });
    void request.then(
      (data) => {
        if (!controller.signal.aborted) setLoad({ id, data });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ id, failed: true });
      },
    );
    return () => controller.abort();
  }, [api, id, nonce]);
  const data = load.id === id ? load.data : undefined;
  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('templates.intro')}</p>
      <div>
        <Button
          data-testid="templates-refresh"
          aria-label={t('templates.refresh')}
          onClick={() => setNonce((n) => n + 1)}
        >
          {t('templates.refresh')}
        </Button>
      </div>
      {!data && (
        <Banner tone={load.failed ? 'error' : 'info'}>
          {t(load.failed ? 'templates.failed' : 'templates.loading')}
        </Banner>
      )}
      {data && (
        <>
          <TemplateErrors invalid={data.invalid} />
          {!data.valid.length && !data.invalid.length && (
            <p>{t(id ? 'templates.missing' : 'templates.empty')}</p>
          )}
          {data.valid.map((template) => (
            <section key={template.id} className={styles.stack}>
              <PixelFrame>
                <h2>{template.name}</h2>
                <Link
                  href={
                    id
                      ? `/workflows/new?template=${encodeURIComponent(template.id)}`
                      : `/templates/${encodeURIComponent(template.id)}`
                  }
                  aria-label={t(id ? 'templates.use' : 'templates.view')}
                  data-testid={`template-${template.id}`}
                >
                  {t(id ? 'templates.use' : 'templates.view')}
                </Link>
              </PixelFrame>
              {id && <TemplateView template={template} />}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

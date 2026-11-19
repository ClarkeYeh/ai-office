import { useState } from 'react';
import type { RepoView } from '@ai-office/contracts/api';
import { t, type MessageKey } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, Field, PixelFrame } from '../../../shared/ui/index.js';
import styles from './repos.module.css';

export function RepoList({
  repos,
  pending,
  loading,
  message,
  error,
  onRegister,
  onRefresh,
  onDetail,
}: {
  repos: readonly RepoView[];
  pending: boolean;
  loading: boolean;
  message: MessageKey | null;
  error: boolean;
  onRegister: (localPath: string) => void;
  onRefresh: () => void;
  onDetail: (id: string) => void;
}) {
  const [path, setPath] = useState('');
  return (
    <div className={styles.page}>
      <p className={styles.intro}>{t('repos.intro')}</p>
      <PixelFrame>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim() && !pending) onRegister(path.trim());
          }}
        >
          <Field
            label={t('repos.path')}
            data-testid="repo-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            required
            disabled={pending}
          />
          <Button
            type="submit"
            variant="primary"
            data-testid="repo-register"
            aria-label={t('repos.register')}
            disabled={!path.trim() || pending}
          >
            {t(pending ? 'workflows.pending' : 'repos.register')}
          </Button>
        </form>
      </PixelFrame>
      {message && (
        <Banner tone={error ? 'error' : 'info'} data-testid="repo-result">
          {t(message)}
        </Banner>
      )}
      <div>
        <Button
          data-testid="repos-refresh"
          aria-label={t('repos.refresh')}
          onClick={onRefresh}
          disabled={pending || loading}
        >
          {t('repos.refresh')}
        </Button>
      </div>
      {loading && <p role="status">{t('repos.loading')}</p>}
      {!loading && !repos.length && <p>{t('repos.empty')}</p>}
      <ul className={styles.list}>
        {repos.map((repo) => (
          <li key={repo.repoId}>
            <PixelFrame>
              <h2>
                {repo.github.owner}/{repo.github.name}
              </h2>
              <p>
                {t(
                  repo.status === 'registered'
                    ? 'repos.registered'
                    : 'repos.invalid',
                )}
              </p>
              <dl className={styles.facts}>
                <dt>{t('repos.path')}</dt>
                <dd>{repo.localPath}</dd>
                <dt>{t('repos.orca')}</dt>
                <dd>{repo.orcaRepoId}</dd>
                <dt>{t('repos.branch')}</dt>
                <dd>{repo.defaultBranch}</dd>
                <dt>{t('repos.protection')}</dt>
                <dd>
                  {t(
                    repo.defaultBranchProtected === 'unknown'
                      ? 'repos.unknown'
                      : repo.defaultBranchProtected
                        ? 'repos.protected'
                        : 'repos.unprotected',
                  )}
                </dd>
                <dt>{t('repos.visibility')}</dt>
                <dd>{t(`repos.${repo.visibility}`)}</dd>
                <dt>{t('repos.owner')}</dt>
                <dd>{repo.ownerLogin}</dd>
              </dl>
              {!!repo.issues.length && (
                <Banner tone="error">
                  <h3>{t('repos.checks')}</h3>
                  <ul>
                    {repo.issues.map((issue, index) => (
                      <li key={index}>{issue}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              <Button
                data-testid={`repo-check-${repo.repoId}`}
                aria-label={t('repos.checkDetail')}
                onClick={() => onDetail(repo.repoId)}
                disabled={pending}
              >
                {t('repos.checkDetail')}
              </Button>
            </PixelFrame>
          </li>
        ))}
      </ul>
    </div>
  );
}

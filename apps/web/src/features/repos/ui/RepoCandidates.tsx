import { useState } from 'react';
import type { RepoCandidatesResponse } from '@ai-office/contracts/api';
import { hasMessage, t } from '../../../shared/lib/i18n/index.js';
import { Banner, Button, PixelFrame } from '../../../shared/ui/index.js';
import {
  cloneCommands,
  localIndex,
  localRowId,
  shortPath,
  viewerLogin,
  type LocalCandidate,
} from '../model/candidates.js';
import styles from './repos.module.css';

const problemText = (code: string) => {
  const key = `repos.problem.${code}`;
  return hasMessage(key) ? t(key) : t('repos.problemUnknown', { code });
};

function LocalRow({
  repo,
  index,
  pending,
  onRegister,
}: {
  repo: LocalCandidate;
  index: number;
  pending: boolean;
  onRegister: (localPath: string) => void;
}) {
  const github = repo.github
    ? `${repo.github.owner}/${repo.github.name}`
    : null;
  return (
    <li id={localRowId(index)} className={styles.row} tabIndex={-1}>
      <div className={styles.rowMain}>
        <h3 className={styles.rowTitle}>{repo.displayName}</h3>
        <p className={styles.meta}>
          {/* A problem line already explains a missing origin. */}
          {github || !repo.problem
            ? `${github ?? t('repos.noGithub')} · `
            : null}
          <span title={repo.path}>{shortPath(repo.path)}</span>
        </p>
        {repo.problem && !repo.registered && (
          <p
            className={styles.problem}
            data-testid={`local-candidate-problem-${index}`}
          >
            {problemText(repo.problem)}
          </p>
        )}
      </div>
      {repo.registered ? (
        <span
          className={styles.done}
          data-testid={`local-candidate-registered-${index}`}
        >
          {t('repos.candidateRegistered')}
        </span>
      ) : (
        <Button
          variant="primary"
          data-testid={`local-candidate-register-${index}`}
          aria-label={t('repos.candidateRegisterAria', {
            name: repo.displayName,
          })}
          disabled={pending || !!repo.problem}
          onClick={() => onRegister(repo.path)}
        >
          {t('repos.candidateRegister')}
        </Button>
      )}
    </li>
  );
}

/**
 * v0.1.1 repo picker: Orca's git repos (registrable) and the viewer's GitHub
 * repos (linked to their local row, or a clone hint that is never run).
 */
export function RepoCandidates({
  candidates,
  loading,
  failed,
  pending,
  onRegister,
  onRefresh,
  onCopy,
}: {
  candidates: RepoCandidatesResponse | null;
  loading: boolean;
  failed: boolean;
  pending: boolean;
  onRegister: (localPath: string) => void;
  onRefresh: () => void;
  /** Resolves when the text is on the clipboard. */
  onCopy: (text: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState<number | null>(null);
  const local = candidates?.local ?? [];
  const remote = candidates?.remote ?? [];
  const login = viewerLogin(remote);
  return (
    <>
      <PixelFrame>
        <section
          className={styles.section}
          aria-labelledby="repo-candidates-local"
          data-testid="repo-candidates-local"
        >
          <div className={styles.sectionHead}>
            <h2 id="repo-candidates-local">{t('repos.localTitle')}</h2>
            <Button
              data-testid="repo-candidates-refresh"
              aria-label={t('repos.candidatesRefreshAria')}
              onClick={onRefresh}
              disabled={loading}
            >
              {t('repos.candidatesRefresh')}
            </Button>
          </div>
          {loading && <p role="status">{t('repos.candidatesLoading')}</p>}
          {failed && !loading && (
            <Banner tone="error" data-testid="repo-candidates-failed">
              {t('repos.candidatesFailed')}
            </Banner>
          )}
          {candidates?.sources.orca === 'unavailable' && (
            <Banner data-testid="repo-candidates-orca-unavailable">
              {t('repos.orcaUnavailable')}
            </Banner>
          )}
          {candidates?.sources.orca === 'ok' && !local.length && (
            <p>{t('repos.localEmpty')}</p>
          )}
          {!!local.length && (
            <ul className={styles.rows}>
              {local.map((repo, index) => (
                <LocalRow
                  key={repo.path}
                  repo={repo}
                  index={index}
                  pending={pending}
                  onRegister={onRegister}
                />
              ))}
            </ul>
          )}
        </section>
      </PixelFrame>
      <PixelFrame>
        <section
          className={styles.section}
          aria-labelledby="repo-candidates-remote"
          data-testid="repo-candidates-remote"
        >
          <h2 id="repo-candidates-remote">
            {login
              ? t('repos.remoteTitle', { login })
              : t('repos.remoteTitleNoLogin')}
          </h2>
          {candidates?.sources.github === 'unavailable' && (
            <Banner data-testid="repo-candidates-github-unavailable">
              {t('repos.githubUnavailable')}
            </Banner>
          )}
          {candidates?.sources.github === 'ok' && !remote.length && (
            <p>{t('repos.remoteEmpty')}</p>
          )}
          {!!remote.length && (
            <ul className={styles.rows}>
              {remote.map((repo, index) => {
                const target = localIndex(local, repo);
                const name = `${repo.owner}/${repo.name}`;
                return (
                  <li
                    key={name}
                    className={`${styles.row} ${repo.archived ? styles.archived : ''}`}
                    data-testid={`remote-candidate-${index}`}
                  >
                    <div className={styles.rowMain}>
                      <h3 className={styles.rowTitle}>{name}</h3>
                      <p className={styles.meta}>
                        {t(`repos.${repo.visibility}`)}
                        {repo.archived && ` · ${t('repos.archived')}`}
                      </p>
                      {target >= 0 ? (
                        <p className={styles.meta}>
                          <a
                            href={`#${localRowId(target)}`}
                            data-testid={`remote-candidate-local-${index}`}
                          >
                            {t('repos.inOrca', {
                              name: local[target]!.displayName,
                            })}
                          </a>
                        </p>
                      ) : (
                        <div className={styles.hint}>
                          <p>
                            <strong>{t('repos.notInOrca')}</strong>
                            {' — '}
                            {t('repos.cloneHint')}
                          </p>
                          <pre
                            className={styles.command}
                            data-testid={`remote-candidate-hint-${index}`}
                          >
                            <code>{cloneCommands(repo)}</code>
                          </pre>
                          <Button
                            data-testid={`remote-candidate-copy-${index}`}
                            aria-label={t(
                              copied === index
                                ? 'repos.copiedAria'
                                : 'repos.copyAria',
                              { name },
                            )}
                            onClick={() => {
                              void onCopy(cloneCommands(repo)).then(
                                () => setCopied(index),
                                () => setCopied(null),
                              );
                            }}
                          >
                            {t(
                              copied === index ? 'repos.copied' : 'repos.copy',
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                    {repo.registered && (
                      <span className={styles.done}>
                        {t('repos.candidateRegistered')}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </PixelFrame>
    </>
  );
}

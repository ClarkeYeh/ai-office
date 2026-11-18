import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiResponse,
  type ApiClient,
} from '../../../api/index.js';
import type { MessageKey } from '../../../shared/lib/i18n/index.js';
import { RepoList } from '../ui/RepoList.js';

type RepoView = ApiResponse<'getRepo'>;

export function ReposPage({ api }: { api: ApiClient }) {
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api.listRepos({ signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRepos(result.repos);
          setLoading(false);
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setMessage('repos.failed');
          setError(true);
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [api, nonce]);
  async function mutate(action: () => Promise<RepoView>, registered: boolean) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setMessage(null);
    setError(false);
    try {
      const repo = await action();
      setRepos((previous) => [
        ...previous.filter((value) => value.repoId !== repo.repoId),
        repo,
      ]);
      setMessage(registered ? 'repos.success' : 'repos.checks');
    } catch (cause) {
      setError(true);
      const code = cause instanceof ApiError ? cause.code : '';
      setMessage(
        code === 'repo_not_main_worktree' ||
          code === 'repo_not_in_orca' ||
          code === 'invalid_github_origin'
          ? `repos.${code}`
          : 'repos.failed',
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <RepoList
      repos={repos}
      pending={pending || loading}
      loading={loading}
      message={message}
      error={error}
      onRegister={(localPath) => {
        void mutate(() => api.registerRepo({ localPath }), true);
      }}
      onRefresh={() => {
        setMessage(null);
        setNonce((value) => value + 1);
      }}
      onDetail={(id) => {
        void mutate(() => api.getRepo(id), false);
      }}
    />
  );
}

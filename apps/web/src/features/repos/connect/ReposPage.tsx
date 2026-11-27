import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  type ApiResponse,
  type ApiClient,
} from '../../../api/index.js';
import type { MessageKey } from '../../../shared/lib/i18n/index.js';
import { RepoCandidates } from '../ui/RepoCandidates.js';
import { RepoList, RepoPageLayout } from '../ui/RepoList.js';

type RepoView = ApiResponse<'getRepo'>;
type Candidates = ApiResponse<'listRepoCandidates'>;

const copyText = async (text: string) => {
  await globalThis.navigator.clipboard.writeText(text);
};

export function ReposPage({
  api,
  copy = copyText,
}: {
  api: ApiClient;
  copy?: (text: string) => Promise<void>;
}) {
  const [repos, setRepos] = useState<RepoView[]>([]);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [message, setMessage] = useState<MessageKey | null>(null);
  const [error, setError] = useState(false);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [candidatesNonce, setCandidatesNonce] = useState(0);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [candidatesFailed, setCandidatesFailed] = useState(false);
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
  useEffect(() => {
    const controller = new AbortController();
    setCandidatesLoading(true);
    setCandidatesFailed(false);
    void api.listRepoCandidates({ signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) {
          setCandidates(result);
          setCandidatesLoading(false);
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setCandidatesFailed(true);
          setCandidatesLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [api, candidatesNonce]);
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
      // The server marks the newly registered candidate ✓.
      if (registered) setCandidatesNonce((value) => value + 1);
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
  const register = (localPath: string) => {
    void mutate(() => api.registerRepo({ localPath }), true);
  };
  return (
    <RepoPageLayout>
      <RepoCandidates
        candidates={candidates}
        loading={candidatesLoading}
        failed={candidatesFailed}
        pending={pending || loading}
        onRegister={register}
        onRefresh={() => setCandidatesNonce((value) => value + 1)}
        onCopy={copy}
      />
      <RepoList
        repos={repos}
        pending={pending || loading}
        loading={loading}
        message={message}
        error={error}
        onRegister={register}
        onRefresh={() => {
          setMessage(null);
          setNonce((value) => value + 1);
        }}
        onDetail={(id) => {
          void mutate(() => api.getRepo(id), false);
        }}
      />
    </RepoPageLayout>
  );
}

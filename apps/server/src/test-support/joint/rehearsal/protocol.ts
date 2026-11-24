/** M5-T11 names shared by the rehearsal child and the harness side. */
import { join } from 'node:path';

/** The spike as the fake runtime's local repo (no local clone is touched). */
export const REHEARSAL_REPO = {
  localPath: '/fake/repos/ai-office-spike',
  runtime: {
    orcaRepoId: 'fake-repo-ai-office-spike',
    localPath: '/fake/repos/ai-office-spike',
  },
  github: { owner: 'ClarkeYeh', name: 'ai-office-spike' },
} as const;

/** The two exact kill windows (M5_PLAN §2.4). */
export type RehearsalWindow = 'P1' | 'P2';

/** The fake runtime's push, served by the harness's world bridge. */
export interface WorldPush {
  worldPush(request: { branch: string; base?: string }): Promise<void>;
}

/** Written by the child once its fake world is flushed and it is frozen. */
export const frozenMarker = (home: string, window: string) =>
  join(home, `rehearsal-frozen-${window}`);

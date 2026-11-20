import { createRedactor } from '@ai-office/redaction';
import { createGithubScm, RepoAllowlist } from '../index.js';
import type { GithubBindingFactory } from '../../../test-support/github/contract-binding.js';
import { contractRepo } from '../../../test-support/github/contract-transport.js';
const redactor = createRedactor();
/** The only adapter assembly point; the recording harness depends on ports. */
export const assembleContractScm: GithubBindingFactory = (options) =>
  createGithubScm({
    ...options,
    timeoutMs: 90_000,
    repoAllowlist: new RepoAllowlist([contractRepo]),
    tokenProvider: async () => 'offline-contract-token',
    maskSecrets: <T>(value: T): T => redactor.sanitize(value) as T,
  });

import { afterEach, expect, it, vi } from 'vitest';
import { ghToken } from './process.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('refuses to read a GitHub credential outside an opted-in live run', async () => {
  for (const env of [
    { AIO_REAL_GITHUB: undefined, CI: undefined },
    { AIO_REAL_GITHUB: '1', CI: '' },
    { AIO_REAL_GITHUB: '1', CI: 'true' },
  ]) {
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    for (const active of [false, true])
      await expect(ghToken(active)).rejects.toThrow('AIO_REAL_GITHUB=1');
  }
});

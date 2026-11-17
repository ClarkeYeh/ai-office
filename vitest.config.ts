import { defineConfig } from 'vitest/config';

// Vitest 4 calls workspace configurations "projects".
export default defineConfig({
  root: import.meta.dirname,
  test: { projects: ['packages/*', 'apps/*'] },
});

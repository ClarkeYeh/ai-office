import { defineConfig } from 'vite';

// Scene harness (M4_PLAN §7.1): a second Vite entry for visual regression and
// the perf smoke. It renders view-model fixtures only and never enters the
// production build (`check:bundle` rejects `test-support/harness` modules).
//   pnpm --dir apps/web exec vite --config vite.harness.config.ts
// Paths come from URL (apps/web may not import node:*).
const local = (path: string) =>
  decodeURIComponent(new URL(path, import.meta.url).pathname);

export default defineConfig({
  root: local('./src/test-support/harness'),
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    outDir: local('./node_modules/.cache/scene-harness'),
    emptyOutDir: true,
  },
});

import { defineConfig } from 'vite';

const importedSpecifiers = new Set<string>();

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  build: { manifest: true, emptyOutDir: false },
  // `ai-office start --dev` admits this origin; the backend checks the raw Host,
  // so the proxy rewrites it to the backend's (§13, §17).
  server: {
    strictPort: true,
    host: 'localhost',
    proxy: Object.fromEntries(
      ['/api', '/auth', '/dev'].map((path) => [
        path,
        {
          target: `http://127.0.0.1:${process.env.AI_OFFICE_PORT ?? '0'}`,
          changeOrigin: true,
        },
      ]),
    ),
  },
  plugins: [
    {
      name: 'architecture-module-stats',
      enforce: 'pre',
      buildStart() {
        importedSpecifiers.clear();
      },
      resolveId(source) {
        // Preserve node: specifiers before Vite replaces them with browser shims.
        importedSpecifiers.add(source);
        return null;
      },
      generateBundle(_options, bundle) {
        // Include external and tree-shaken imports: a manifest only lists entries.
        const modules = new Set<string>(importedSpecifiers);
        for (const id of this.getModuleIds()) {
          modules.add(id);
          const info = this.getModuleInfo(id);
          for (const imported of [
            ...(info?.importedIds ?? []),
            ...(info?.dynamicallyImportedIds ?? []),
          ]) {
            modules.add(imported);
          }
        }
        this.emitFile({
          type: 'asset',
          fileName: '.vite/module-stats.json',
          source: JSON.stringify(
            {
              modules: [...modules].sort(),
              chunks: Object.values(bundle)
                .filter((item) => item.type === 'chunk')
                .map((chunk) => chunk.fileName)
                .sort(),
            },
            null,
            2,
          ),
        });
      },
    },
  ],
});

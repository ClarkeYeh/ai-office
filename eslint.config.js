import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'docs/**',
      'packages/contracts/generated/**',
      'scripts/depcruise-selftest/samples/**',
    ],
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/cli/src/**/*.ts'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    languageOptions: { globals: { document: 'readonly' } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { module: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettier,
);

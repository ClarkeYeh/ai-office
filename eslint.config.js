import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.dev-home/**',
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
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    ignores: ['apps/web/src/shared/lib/i18n/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/[\\u3400-\\u9fff\\uf900-\\ufaff]/]',
          message: 'Use an i18n key for UI text.',
        },
        {
          selector: 'JSXText[value=/[\\u3400-\\u9fff\\uf900-\\ufaff]/]',
          message: 'Use an i18n key for UI text.',
        },
        {
          selector:
            'TemplateElement[value.raw=/[\\u3400-\\u9fff\\uf900-\\ufaff]/]',
          message: 'Use an i18n key for UI text.',
        },
      ],
    },
  },
  {
    files: [
      'apps/web/src/features/*/model/**/*.ts',
      'apps/web/src/shared/lib/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/test-support/**'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage'],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Pass now as a parameter.',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Pass deterministic input as a parameter.',
        },
        ...['window', 'document', 'localStorage'].map((property) => ({
          object: 'globalThis',
          property,
          message: 'Keep this layer pure.',
        })),
      ],
    },
  },
  {
    files: ['apps/web/src/features/office/scene/sprites/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.{1,2}/(?!.*\\.ts$)',
              message:
                'Sprite relative imports must end in .ts for Node type stripping.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);

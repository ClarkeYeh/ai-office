import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ai-office/server',
    exclude: [...configDefaults.exclude, '**/*.orca.test.ts'],
  },
});

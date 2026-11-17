import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { builtinTemplateUrls } from '@ai-office/templates';
import { WorkflowTemplateSchema } from '@ai-office/contracts/template';

test('all built-in templates satisfy the workflow contract', async () => {
  expect(builtinTemplateUrls.length).toBeGreaterThan(0);
  for (const url of builtinTemplateUrls) {
    const value: unknown = parse(await readFile(url, 'utf8'));
    const parsed = WorkflowTemplateSchema.parse(value);
    expect(
      WorkflowTemplateSchema.parse(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(value);
  }
});

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { builtinTemplateUrls } from '@ai-office/templates';
import { parse, stringify } from 'yaml';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import { createTemplateFsRepository } from './index.js';

let dataDir: string;
let template: WorkflowTemplate;
const file = (name = 'feature-to-pr.yaml') => join(dataDir, 'templates', name);
const save = (name = 'feature-to-pr.yaml') =>
  writeFile(file(name), stringify(template));
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'aio-template-fs-'));
  template = parse(
    await readFile(builtinTemplateUrls[0]!, 'utf8'),
  ) as WorkflowTemplate;
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test('initializes all built-ins and preserves existing user files across startups', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  expect((await repository.list()).valid).toHaveLength(
    builtinTemplateUrls.length,
  );
  expect((await repository.list()).invalid).toEqual([]);
  template.name = 'User customization';
  await save();
  const restarted = await createTemplateFsRepository(dataDir);
  expect(await restarted.get(template.id)).toEqual(template);
});

test('preserves even an invalid pre-existing built-in without overwriting', async () => {
  await mkdir(join(dataDir, 'templates'));
  await writeFile(file(), 'invalid: [');
  await createTemplateFsRepository(dataDir);
  expect(await readFile(file(), 'utf8')).toBe('invalid: [');
});

test('list and get reread edits, additions and deletions without restoring deleted files', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  template.name = 'Edited';
  await save();
  expect(await repository.get(template.id)).toEqual(template);
  expect((await repository.list()).valid[0]?.name).toBe('Edited');
  template.id = 'custom';
  await save('custom.yaml');
  expect(await repository.get('custom')).toEqual(template);
  expect((await repository.list()).valid).toHaveLength(2);
  await rm(file('custom.yaml'));
  await rm(file());
  expect(await repository.get('custom')).toBeNull();
  expect(await repository.list()).toEqual({ valid: [], invalid: [] });
});

test('reports filename/id mismatch and does not resolve by the mismatched id', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  template.id = 'different';
  await save();
  const result = await repository.get('feature-to-pr');
  expect(result).toMatchObject({
    file: 'feature-to-pr.yaml',
    issues: [{ path: 'id', message: expect.any(String) }],
  });
  expect(await repository.list()).toEqual({ valid: [], invalid: [result] });
  expect(await repository.get('different')).toBeNull();
});

test('reports YAML syntax errors without source snippets alongside valid templates', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  await writeFile(file('broken.yaml'), 'name: [\n');
  const result = await repository.get('broken');
  expect(result).toMatchObject({
    file: 'broken.yaml',
    issues: [{ path: '', message: expect.any(String) }],
  });
  const listing = await repository.list();
  expect(listing.valid).toHaveLength(builtinTemplateUrls.length);
  expect(listing.invalid).toEqual([result]);
});

test('reports nested Zod paths and semantic reference errors', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  template.roles.lead!.scope = 'x'.repeat(1001);
  await save();
  expect(await repository.get(template.id)).toMatchObject({
    issues: expect.arrayContaining([
      { path: 'roles.lead.scope', message: expect.any(String) },
    ]),
  });
  delete template.roles.lead!.scope;
  const meeting = template.stages[0]!;
  if (meeting.kind !== 'meeting') throw new Error('Expected built-in meeting');
  meeting.facilitator = 'missing';
  await save();
  expect(await repository.get(template.id)).toMatchObject({
    issues: expect.arrayContaining([
      { path: 'stages.0.facilitator', message: expect.any(String) },
    ]),
  });
});

test('returns null for absent ids and refuses path traversal', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  await writeFile(
    join(dataDir, 'outside.yaml'),
    stringify({ ...template, id: '../outside' }),
  );
  for (const id of [
    'missing',
    '../outside',
    '/outside',
    '..\\outside',
    '',
    '\0',
  ]) {
    expect(await repository.get(id)).toBeNull();
  }
});

test('ignores non-yaml entries and directories', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  await writeFile(file('notes.txt'), 'not a template');
  await mkdir(file('directory.yaml'));
  expect((await repository.list()).invalid).toEqual([]);
  expect((await repository.list()).valid).toHaveLength(
    builtinTemplateUrls.length,
  );
});

test('handles invalid YAML aliases as invalid templates', async () => {
  const repository = await createTemplateFsRepository(dataDir);
  await writeFile(file('alias.yaml'), 'id: *undefined');
  expect(await repository.get('alias')).toMatchObject({
    file: 'alias.yaml',
    issues: [{ path: '', message: expect.any(String) }],
  });
});

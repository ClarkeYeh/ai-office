import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const model = 'apps/web/src/features/office/model/probe.ts';
const ui = 'apps/web/src/features/office/ui/Probe.tsx';
const sprite = 'apps/web/src/features/office/scene/sprites/probe.ts';
const probes = /** @type {[string, string, string][]} */ ([
  [model, 'export const now = Date.now();', 'no-restricted-properties'],
  [model, 'export const random = Math.random();', 'no-restricted-properties'],
  [model, 'export const dom = window;', 'no-restricted-globals'],
  [model, 'export const dom = document;', 'no-restricted-globals'],
  [model, 'export const storage = localStorage;', 'no-restricted-globals'],
  [
    'apps/web/src/shared/lib/probe.ts',
    'export const now = Date.now();',
    'no-restricted-properties',
  ],
  [ui, 'export const x = <span>需要你</span>;', 'no-restricted-syntax'],
  [ui, 'export const x = <span title="需要你" />;', 'no-restricted-syntax'],
  [ui, 'export const x = `需要你`;', 'no-restricted-syntax'],
  [ui, 'export const x = "\\u9700\\u8981\\u4f60";', 'no-restricted-syntax'],
  [sprite, "import './palette.js';", 'no-restricted-imports'],
  [
    ui,
    "import { useState } from 'react'; export function invalid() { return useState(0); }",
    'react-hooks/rules-of-hooks',
  ],
]);
for (const [filePath, source, rule] of probes) {
  test(`lint rejects ${source} in ${filePath}`, async () => {
    const [result] = await eslint.lintText(source, { filePath });
    assert(
      result?.messages.some((message) => message.ruleId === rule),
      JSON.stringify(result?.messages),
    );
  });
}
test('lint permits injected time, translation keys and .ts sprite imports', async () => {
  for (const [filePath, source] of /** @type {[string, string][]} */ ([
    [
      model,
      'export const elapsed = (now: number, start: number) => now - start;',
    ],
    [
      ui,
      'export const Button = ({ label }: { label: string }) => <button>{label}</button>;',
    ],
    [sprite, "import './palette.ts';"],
  ])) {
    const [result] = await eslint.lintText(source, { filePath });
    assert.equal(result?.errorCount, 0, JSON.stringify(result?.messages));
  }
});

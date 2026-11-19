import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PALETTE } from './sprites/palette.js';

// Vendor badges are 10px text: WCAG AA needs 4.5:1, from Endesga 32 only.
const css = readFileSync(
  new URL('./scene.module.css', import.meta.url),
  'utf8',
);

const rule = (selector: string, property: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  const match = new RegExp(`\\n\\s*${property}:\\s*(#[0-9a-f]{6})`).exec(body);
  expect(match, `${selector} ${property}`).not.toBeNull();
  return match![1]!;
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('nameplate vendor badges', () => {
  const text = rule('.badge', 'color');
  test.each(['CC', 'CX'])('%s text meets AA on its badge', (badge) => {
    const background = rule(`.badge[data-badge='${badge}']`, 'background');
    const palette: string[] = Object.values(PALETTE);
    expect(palette).toContain(text);
    expect(palette).toContain(background);
    expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
  });
  test('Claude Code keeps its sky blue', () => {
    expect(rule(".badge[data-badge='CC']", 'background')).toBe(PALETTE.sky);
  });
});

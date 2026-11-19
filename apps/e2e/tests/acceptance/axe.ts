import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** axe: no serious or critical violation on the current page (§7.1). */
export async function expectNoBlockingAxe(
  page: Page,
  label: string,
): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations
      .filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? ''),
      )
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(' '))
            .join(', ')})`,
      ),
    label,
  ).toEqual([]);
}

/**
 * Presses Tab until the focused element's test id satisfies `done`, recording
 * every test id reached on the way in `reached`.
 */
export async function tabUntil(
  page: Page,
  reached: string[],
  done: (testId: string) => boolean,
  limit = 80,
): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? '',
    );
    if (id) reached.push(id);
    if (id && done(id)) return;
  }
  throw new Error(`Tab never reached the target: ${reached.join(' → ')}`);
}

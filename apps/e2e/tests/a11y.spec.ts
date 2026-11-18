import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'demo' });

/** Every page of the app; feature tasks add their routes here. */
const PAGES = ['/', '/workflows/new', '/templates', '/repos'];

for (const path of PAGES) {
  test(`${path} has no serious or critical axe violations`, async ({
    page,
  }) => {
    await office().login(page, path);
    await expect(page.getByTestId('home-link')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    const blocking = violations.filter((violation) =>
      ['serious', 'critical'].includes(violation.impact ?? ''),
    );
    expect(
      blocking.map((violation) => `${violation.id}: ${violation.help}`),
    ).toEqual([]);
  });

  test(`${path} runs no animation under reduced motion`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await office().login(page, path);
    await expect(page.getByTestId('home-link')).toBeVisible();
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
}

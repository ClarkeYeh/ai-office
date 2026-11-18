import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { useOffice } from '../test-support/index.js';

const office = useOffice({ scenario: 'demo' });

/** Every page of the app; feature tasks add their routes here. */
const PAGES = ['/'];

for (const path of PAGES) {
  test(`${path} has no serious or critical axe violations`, async ({
    page,
  }) => {
    await office().login(page, path);
    await expect(page.locator('#root')).not.toBeEmpty();
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
    await expect(page.locator('#root')).not.toBeEmpty();
    const running = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
}

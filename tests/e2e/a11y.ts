import AxeBuilder from '@axe-core/playwright';
import { expect, type BrowserContext, type Page } from '@playwright/test';

/** axe (WCAG 2.2 AA) and a screenshot of each ledger screen in the three themes. */
export async function checkThemes(
  page: Page,
  context: BrowserContext,
  screens: Record<string, string>,
) {
  for (const theme of ['light', 'dark', 'black'] as const) {
    await context.addCookies([
      { name: 'kantora-theme', value: theme, url: 'http://localhost:3000' },
    ]);
    for (const [name, url] of Object.entries(screens)) {
      await page.goto(url);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main')).not.toBeEmpty();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const violations = results.violations.map(
        (v) => `${name}: ${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      );
      expect(violations).toEqual([]);
      await page.screenshot({ path: `test-results/screens/${name}-${theme}.png`, fullPage: true });
    }
  }
}

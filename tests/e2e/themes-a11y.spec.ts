/**
 * Accessibility (axe-core, WCAG 2.2 A/AA) and screenshots of /design in all three themes
 * (PROMPT.md 5.1, 9). Screenshots are written to test-results/screens for review; they
 * are not pixel-compared, because fonts render differently between Windows and CI.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const THEMES = ['light', 'dark', 'black'] as const;

for (const theme of THEMES) {
  test(`/design passes axe and is captured in the ${theme} theme`, async ({ page, context }) => {
    await context.addCookies([
      { name: 'kantora-theme', value: theme, url: 'http://localhost:3000' },
    ]);
    await page.goto('/design');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByText('Ред 1 от 100')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const violations = results.violations.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
    expect(violations).toEqual([]);

    await page.screenshot({ path: `test-results/screens/design-${theme}.png`, fullPage: true });
  });

  test(`login page passes axe in the ${theme} theme`, async ({ page, context }) => {
    await context.addCookies([
      { name: 'kantora-theme', value: theme, url: 'http://localhost:3000' },
    ]);
    await page.goto('/login');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await page.screenshot({ path: `test-results/screens/login-${theme}.png` });
  });
}

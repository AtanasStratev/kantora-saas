import AxeBuilder from '@axe-core/playwright';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { sharedOwner } from './owner';

if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Removes the theme stored for the shared test user, so the next test starts from the
 * same state as a new user (other tests set the theme by cookie).
 */
async function forgetStoredTheme(): Promise<void> {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`SELECT set_config('app.system_actor', 'e2e-theme-reset', true)`);
    await admin.query(
      `DELETE FROM app.user_preference WHERE user_id = (SELECT id FROM auth."user" WHERE email = $1)`,
      [sharedOwner().email],
    );
    await admin.query('COMMIT');
  } finally {
    await admin.end();
  }
}

const THEMES = ['light', 'dark', 'black'] as const;

/**
 * Switches the theme the way a user does (Alt+T), which also stores it for the user. The
 * stored preference wins over the browser cookie (app/layout.tsx), so setting only the
 * cookie fails once another test has stored a theme for the shared test user.
 */
async function useTheme(page: Page, theme: (typeof THEMES)[number]) {
  const html = page.locator('html');
  for (let i = 0; i < 5 && (await html.getAttribute('data-theme')) !== theme; i++) {
    const before = await html.getAttribute('data-theme');
    // Wait for the save (a server action POST) to finish: a reload would cancel it.
    const saved = page.waitForResponse((r) => r.request().method() === 'POST');
    await page.locator('body').press('Alt+T');
    await expect(html).not.toHaveAttribute('data-theme', before ?? '');
    await saved;
  }
  await expect(html).toHaveAttribute('data-theme', theme);
  // Stored for the user: a fresh page load shows it too (the save is asynchronous).
  await expect
    .poll(async () => {
      await page.reload();
      return html.getAttribute('data-theme');
    })
    .toBe(theme);
}

/** axe (WCAG 2.2 AA) and a screenshot of each screen in the three themes. */
export async function checkThemes(
  page: Page,
  _context: BrowserContext,
  screens: Record<string, string>,
) {
  const first = Object.values(screens)[0];
  for (const theme of THEMES) {
    // No cookie here: a cookie that differs from the stored theme makes the page save the
    // stored one again, in parallel with Alt+T.
    if (first) {
      await page.goto(first);
      await useTheme(page, theme);
    }
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
  await forgetStoredTheme();
}

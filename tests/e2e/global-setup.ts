/**
 * Registers ONE office owner for the whole run (sign-up is rate limited to 3/min per IP,
 * on purpose) and stores the signed-in browser state plus the credentials for reuse.
 */
import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { registerOwner } from './helpers';

export const STATE = 'test-results/.auth/owner.json';
export const CREDS = 'test-results/.auth/owner-creds.json';

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3000';
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL, viewport: { width: 1366, height: 800 } });
  const user = await registerOwner(page, 'E2E Обща кантора');
  await page.waitForURL(`${baseURL}/`);
  mkdirSync('test-results/.auth', { recursive: true });
  await page.context().storageState({ path: STATE });
  writeFileSync(CREDS, JSON.stringify(user));
  await browser.close();
}

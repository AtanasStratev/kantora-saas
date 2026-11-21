import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
// Same RFC 6238 implementation the developers use by hand (scripts/dev-totp.mjs).
import { totp } from '../../scripts/dev-totp.mjs';

export type TestUser = { email: string; password: string; name: string; secret: string };

/** Unique, obviously fake test identities on the reserved .test domain. */
export function newIdentity(prefix: string): Omit<TestUser, 'secret'> {
  const id = randomBytes(4).toString('hex');
  return {
    email: `${prefix}-${id}@kantora.test`,
    password: `E2e-${randomBytes(9).toString('base64url')}`,
    name: `E2E ${prefix} ${id}`,
  };
}

/**
 * A TOTP code that was not used yet: Better Auth may reject a code reused within the
 * same 30-second window, so wait for a fresh window when needed.
 */
let lastCode = '';
export async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const code = totp(secret);
    if (code !== lastCode) {
      lastCode = code;
      return code;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Registers an office owner through the UI, keyboard only, and enables 2FA. */
export async function registerOwner(page: Page, officeName: string): Promise<TestUser> {
  const who = newIdentity('owner');
  await page.goto('/register');
  await page.getByLabel('Име на кантората').fill(officeName);
  await page.keyboard.press('Tab');
  await page.keyboard.type(who.name);
  await page.keyboard.press('Tab');
  await page.keyboard.type(who.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(who.password);
  await page.keyboard.press('Tab');
  await page.keyboard.type(who.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/2fa\/setup/);
  const secret = await enableTwoFactor(page, who.password);
  return { ...who, secret };
}

/** On /2fa/setup: confirms the password, reads the secret and submits a code. */
export async function enableTwoFactor(page: Page, password: string): Promise<string> {
  await page.getByLabel('Потвърдете паролата си').fill(password);
  await page.keyboard.press('Enter');
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel(/6-цифрения код/).fill(await freshCode(secret));
  await page.keyboard.press('Enter');
  return secret;
}

export async function signIn(page: Page, user: TestUser, next = '/'): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Имейл').fill(user.email);
  await page.getByLabel('Парола').fill(user.password);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login\/2fa/);
  await page.getByLabel('Код от приложението').fill(await freshCode(user.secret));
  await page.keyboard.press('Enter');
}

/** Signs out the way a user does: Ctrl+K, "изход", Enter. */
export async function signOut(page: Page): Promise<void> {
  if (!/\/(login|register)/.test(page.url())) {
    await page.goto('/');
  }
  await page.locator('body').press('Control+K');
  await page.keyboard.type('изход');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/login/);
}

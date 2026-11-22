import { expect as baseExpect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
// Same RFC 6238 implementation the developers use by hand (scripts/dev-totp.mjs).
import { totp } from '../../scripts/dev-totp.mjs';
import { latestLink } from '../../scripts/mailpit.mjs';

// Helpers also run in global setup, outside the test runner's expect config: be generous
// (first requests compile pages in dev, and Argon2 hashing is deliberately slow).
const expect = baseExpect.configure({ timeout: 30_000 });

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

/** Fills the registration form (keyboard only) and waits for "check your e-mail". */
export async function submitRegistration(
  page: Page,
  officeName: string,
  who: Omit<TestUser, 'secret'>,
): Promise<number> {
  const sentAfter = Date.now() - 1000;
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
  await expect(page.getByRole('status')).toContainText('Изпратихме връзка');
  return sentAfter;
}

/** Opens the newest link from an e-mail, as the user would from their inbox. */
export async function openMailLink(page: Page, to: string, subject: string, after = 0) {
  await page.goto(await latestLink(to, subject, { after }));
}

/**
 * Full owner onboarding through the UI: register → confirm e-mail → enable 2FA →
 * create the office (name carried over from the form).
 */
export async function registerOwner(page: Page, officeName: string): Promise<TestUser> {
  const who = newIdentity('owner');
  const after = await submitRegistration(page, officeName, who);
  await openMailLink(page, who.email, 'Потвърдете имейла', after);
  await expect(page).toHaveURL(/\/2fa\/setup/);
  const secret = await enableTwoFactor(page, who.password);
  await expect(page.getByLabel('Име на кантората')).toHaveValue(officeName);
  await page.keyboard.press('Enter');
  await expect(page.locator('header')).toContainText(officeName);
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

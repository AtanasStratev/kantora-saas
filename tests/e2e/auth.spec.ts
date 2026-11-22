import { expect, test } from '@playwright/test';
import {
  freshCode,
  newIdentity,
  openMailLink,
  registerOwner,
  signIn,
  signOut,
  submitRegistration,
} from './helpers';
import { sharedOwner } from './owner';

test.describe('sign-up, mandatory 2FA and sign-in', () => {
  test('sign-in needs password AND code; wrong values are explained', async ({ page }) => {
    // The shared owner was registered with 2FA in global-setup.ts.
    const user = sharedOwner();
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Имейл').fill(user.email);
    await page.getByLabel('Парола').fill('wrong-password-123');
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByRole('alert')).toHaveText('Грешен имейл или парола.');

    await page.getByLabel('Парола').fill(user.password);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/login\/2fa/);
    await page.getByLabel('Код от приложението').fill('000000');
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByRole('alert')).toContainText('Кодът е грешен');

    await page.getByLabel('Код от приложението').fill(await freshCode(user.secret));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/');
    await expect(page.locator('header')).toContainText('E2E Обща кантора');
    await signOut(page);
  });

  test('no sign-in before the e-mail is confirmed; then 2FA is still required', async ({
    page,
  }) => {
    const who = newIdentity('unverified');
    const after = await submitRegistration(page, 'E2E Непотвърден', who);

    // Signing in before opening the link is refused with a clear message.
    await page.goto('/login');
    await page.getByLabel('Имейл').fill(who.email);
    await page.getByLabel('Парола').fill(who.password);
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByRole('alert')).toContainText('не е потвърден');

    // The e-mail link signs the user in, but nothing is reachable until 2FA is on.
    await openMailLink(page, who.email, 'Потвърдете имейла', after);
    await expect(page).toHaveURL(/\/2fa\/setup/);
    for (const path of ['/', '/companies', '/team', '/account']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/2fa\/setup/);
    }
  });

  test('forgotten password: e-mail link, new password, all sessions end, 2FA stays', async ({
    page,
  }) => {
    const user = await registerOwner(page, 'E2E Забравена парола');
    const sentAfter = Date.now() - 1000;
    await signOut(page);
    await page.getByRole('link', { name: 'Забравена парола?' }).click();
    await expect(page).toHaveURL('/forgot-password');
    await expect(page.getByRole('heading', { name: 'Забравена парола' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Имейл').fill(user.email);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Ако има профил');

    await openMailLink(page, user.email, 'Смяна на парола', sentAfter);
    const newPassword = `${user.password}-new`;
    await page.getByLabel('Нова парола').fill(newPassword);
    await page.getByLabel('Повторете паролата').fill(newPassword);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Паролата е сменена');

    // The old password no longer works; the new one still needs the authenticator code.
    await page.goto('/login');
    await page.getByLabel('Имейл').fill(user.email);
    await page.getByLabel('Парола').fill(user.password);
    await page.keyboard.press('Enter');
    await expect(page.locator('form').getByRole('alert')).toHaveText('Грешен имейл или парола.');
    await signIn(page, { ...user, password: newPassword });
    await expect(page.locator('header')).toContainText('E2E Забравена парола');
  });

  test('unknown e-mail on "forgot password" gets the same answer (no account probing)', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Имейл').fill('nobody-at-all@kantora.test');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Ако има профил');
  });

  test('next-redirect after sign-in stays on this site', async ({ page }) => {
    await signIn(page, sharedOwner(), 'https://evil.example/steal');
    await expect(page).toHaveURL('/');
  });
});

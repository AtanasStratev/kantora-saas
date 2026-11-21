import { expect, test } from '@playwright/test';
import { freshCode, signIn, signOut } from './helpers';
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

  test('a session without 2FA cannot reach the app', async ({ page }) => {
    // Sign up but stop before enabling 2FA.
    await page.goto('/register');
    const id = Date.now().toString(36);
    await page.getByLabel('Име на кантората').fill('E2E Без 2FA');
    await page.getByLabel('Вашето име').fill('Без 2FA');
    await page.getByLabel('Имейл').fill(`no2fa-${id}@kantora.test`);
    await page.getByLabel('Парола', { exact: true }).fill(`E2e-no2fa-${id}-pass`);
    await page.getByLabel('Повторете паролата').fill(`E2e-no2fa-${id}-pass`);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/2fa\/setup/);
    for (const path of ['/', '/companies', '/team']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/2fa\/setup/);
    }
  });

  test('next-redirect after sign-in stays on this site', async ({ page }) => {
    await signIn(page, sharedOwner(), 'https://evil.example/steal');
    await expect(page).toHaveURL('/');
  });
});

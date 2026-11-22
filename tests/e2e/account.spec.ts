import { expect, test } from '@playwright/test';
import { registerOwner, signIn } from './helpers';

test('profile lists active sessions and can end the other ones', async ({ page, browser }) => {
  const user = await registerOwner(page, 'E2E Сесии');

  // A second device signs in.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await signIn(otherPage, user);
  await expect(otherPage.locator('header')).toContainText('E2E Сесии');

  await page.goto('/account');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('това устройство');

  await page.getByRole('button', { name: /Излез от всички други устройства/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Прекрати всички' }).click();
  await expect(rows).toHaveCount(1);

  // The other device is signed out on its next request.
  await otherPage.goto('/');
  await expect(otherPage).toHaveURL(/\/login/);
  await other.close();
});

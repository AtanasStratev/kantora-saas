import { expect, test } from '@playwright/test';
import { enableTwoFactor, newIdentity, openMailLink } from './helpers';
import { OWNER_STATE } from './owner';

test('invitation by e-mail: register, confirm e-mail, 2FA, accept, see only granted data', async ({
  browser,
}) => {
  // The owner (shared, signed in) invites an accountant from the Team page.
  const ownerCtx = await browser.newContext({ storageState: OWNER_STATE });
  const owner = await ownerCtx.newPage();
  const invitee = newIdentity('invitee');
  const invitedAt = Date.now() - 1000;
  await owner.goto('/team');
  await owner.getByLabel('Имейл').fill(invitee.email);
  await owner.keyboard.press('Enter');
  await expect(owner.getByTestId('invite-link')).toBeVisible();
  await expect(owner.getByText('Поканата е изпратена по имейл')).toBeVisible();
  await expect(owner.getByText(invitee.email)).toBeVisible(); // pending list
  await ownerCtx.close();

  // The invitee opens the e-mail in a fresh browser.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await openMailLink(page, invitee.email, 'Покана за', invitedAt);
  await expect(page.getByRole('heading', { name: /Покана за/ })).toBeVisible();
  await page.getByRole('link', { name: 'Нямам профил: регистрация' }).click();
  await expect(page.getByLabel('Имейл')).toHaveValue(invitee.email);
  await expect(page.getByLabel('Име на кантората')).toHaveCount(0);
  const signedUpAt = Date.now() - 1000;
  await page.getByLabel('Вашето име').fill(invitee.name);
  await page.getByLabel('Парола', { exact: true }).fill(invitee.password);
  await page.getByLabel('Повторете паролата').fill(invitee.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Изпратихме връзка');

  await openMailLink(page, invitee.email, 'Потвърдете имейла', signedUpAt);
  await expect(page).toHaveURL(/\/2fa\/setup/);
  await enableTwoFactor(page, invitee.password);
  await expect(page).toHaveURL(/\/invite\//);
  await page.getByRole('button', { name: 'Приеми поканата' }).click();
  await expect(page.locator('header')).toContainText('E2E Обща кантора');
  await expect(page.getByText('Още нямате достъп до фирми')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Екип/ })).toHaveCount(0);
  await ctx.close();
});

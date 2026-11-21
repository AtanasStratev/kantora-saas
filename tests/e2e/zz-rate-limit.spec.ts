/** Runs last (file order): it deliberately exhausts the sign-in limit for this IP. */
import { expect, test } from '@playwright/test';
test('sign-in attempts are rate limited (429)', async ({ request }) => {
  // Limit is 5/min in production; dev/e2e multiply it (see .env.example). Either way a
  // burst well above the limit must be refused.
  const statuses: number[] = [];
  for (let i = 0; i < 120 && !statuses.includes(429); i++) {
    const r = await request.post('/api/auth/sign-in/email', {
      headers: { Origin: 'http://localhost:3000' },
      data: { email: 'nobody@kantora.test', password: 'wrong-password-xyz' },
    });
    statuses.push(r.status());
  }
  expect(statuses).toContain(429);
});

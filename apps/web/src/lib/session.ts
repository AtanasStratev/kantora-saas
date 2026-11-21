import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth, type Session } from './auth';

/**
 * Returns the session or redirects to /login. Unless `allowWithout2fa` is set, also
 * redirects users who have not finished TOTP setup: 2FA is mandatory (ADR-0005), so no
 * data is reachable before it is enabled.
 */
export async function requireSession(opts: { allowWithout2fa?: boolean } = {}): Promise<Session> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }
  if (!opts.allowWithout2fa && !session.user.twoFactorEnabled) {
    redirect('/2fa/setup');
  }
  return session;
}

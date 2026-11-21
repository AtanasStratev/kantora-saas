'use server';
import { withUser } from '@kantora/db';
import { cookies, headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { appPool } from '@/lib/db';
import { isTheme, THEME_COOKIE, type Theme } from './theme';

/** Saves the theme in a cookie (no flash on load) and, when signed in, for the user. */
export async function setTheme(theme: Theme): Promise<void> {
  if (!isTheme(theme)) return;
  (await cookies()).set(THEME_COOKIE, theme, {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    maxAge: 60 * 60 * 24 * 365,
  });
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user.twoFactorEnabled) return;
  await withUser(appPool, session.user.id, async (c) => {
    // Users not yet linked to an office have no app.users row; nothing to store then.
    const linked = await c.query('SELECT 1 FROM app.users WHERE id = $1', [session.user.id]);
    if (linked.rowCount === 0) return;
    await c.query(
      `INSERT INTO app.user_preference (user_id, theme) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET theme = EXCLUDED.theme, updated_at = now()
       WHERE app.user_preference.theme IS DISTINCT FROM EXCLUDED.theme`,
      [session.user.id, theme],
    );
  });
}

/** The theme stored for the signed-in user, if any. */
export async function storedTheme(userId: string): Promise<Theme | null> {
  return withUser(appPool, userId, async (c) => {
    const r = await c.query<{ theme: string }>(
      'SELECT theme FROM app.user_preference WHERE user_id = $1',
      [userId],
    );
    const t = r.rows[0]?.theme;
    return isTheme(t) ? t : null;
  });
}

'use server';
import { withUser } from '@kantora/db';
import { cookies } from 'next/headers';
import { DatabaseError } from 'pg';
import { COMPANY_COOKIE, OFFICE_COOKIE, PERIOD_COOKIE } from '@/lib/context';
import { appPool } from '@/lib/db';
import { requireSession } from '@/lib/session';

export async function acceptInvite(token: string): Promise<{ error?: string }> {
  const session = await requireSession();
  try {
    const officeId = await withUser(appPool, session.user.id, async (c) => {
      const r = await c.query<{ office: string }>('SELECT app.accept_invitation($1) AS office', [
        token,
      ]);
      return r.rows[0]?.office;
    });
    if (officeId) {
      const jar = await cookies();
      const opts = {
        path: '/',
        sameSite: 'lax' as const,
        httpOnly: true,
        maxAge: 60 * 60 * 24 * 365,
      };
      jar.set(OFFICE_COOKIE, officeId, opts);
      jar.delete(COMPANY_COOKIE);
      jar.delete(PERIOD_COOKIE);
    }
    return {};
  } catch (err) {
    if (err instanceof DatabaseError && (err.code === '42501' || err.code === '22023')) {
      return { error: err.message };
    }
    throw err;
  }
}

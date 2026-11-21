'use server';
import { withUser } from '@kantora/db';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { appPool } from '@/lib/db';
import { requireSession } from '@/lib/session';

const OfficeName = z.string().trim().min(2, 'Името на кантората е твърде кратко.').max(200);

/** Creates the signed-in user's first office (they become its owner). */
export async function registerOffice(officeName: string): Promise<{ error?: string }> {
  const session = await requireSession({ allowWithout2fa: true });
  const parsed = OfficeName.safeParse(officeName);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Невалидно име.' };
  }
  try {
    await withUser(appPool, session.user.id, (c) =>
      c.query('SELECT app.register_office($1)', [parsed.data]),
    );
    return {};
  } catch (err) {
    // Messages raised by the DB functions are written for users (Bulgarian, actionable).
    if (err instanceof DatabaseError && (err.code === '42501' || err.code === '22023')) {
      return { error: err.message };
    }
    throw err;
  }
}

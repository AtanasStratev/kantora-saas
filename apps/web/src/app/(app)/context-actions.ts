'use server';
import { withTenant } from '@kantora/db';
import { cookies } from 'next/headers';
import { DatabaseError } from 'pg';
import { z } from 'zod';
import { COMPANY_COOKIE, getAppContext, OFFICE_COOKIE, PERIOD_COOKIE } from '@/lib/context';
import { appPool } from '@/lib/db';

const COOKIE = { path: '/', sameSite: 'lax' as const, httpOnly: true, maxAge: 60 * 60 * 24 * 365 };

/** Selections are validated against lists read under RLS before they are stored. */
export async function selectOffice(officeId: string): Promise<void> {
  const ctx = await getAppContext();
  if (!ctx.offices.some((o) => o.id === officeId)) return;
  const jar = await cookies();
  jar.set(OFFICE_COOKIE, officeId, COOKIE);
  jar.delete(COMPANY_COOKIE);
  jar.delete(PERIOD_COOKIE);
}

export async function selectCompany(companyId: string): Promise<void> {
  const ctx = await getAppContext();
  if (!ctx.companies.some((c) => c.id === companyId)) return;
  const jar = await cookies();
  jar.set(COMPANY_COOKIE, companyId, COOKIE);
  jar.delete(PERIOD_COOKIE);
}

export async function selectPeriod(periodId: string): Promise<void> {
  const ctx = await getAppContext();
  if (!ctx.periods.some((p) => p.id === periodId)) return;
  (await cookies()).set(PERIOD_COOKIE, periodId, COOKIE);
}

const NewCompany = z.object({
  name: z.string().trim().min(2, 'Името на фирмата е твърде кратко.').max(200),
  eik: z
    .string()
    .trim()
    .regex(/^(\d{9}|\d{13})?$/, 'ЕИК трябва да е 9 или 13 цифри (или оставете празно).'),
});

export async function createCompany(input: {
  name: string;
  eik: string;
}): Promise<{ error?: string; id?: string }> {
  const ctx = await getAppContext();
  if (!ctx.office) return { error: 'Първо изберете кантора.' };
  const parsed = NewCompany.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Невалидни данни.' };
  try {
    const id = await withTenant(
      appPool,
      { userId: ctx.user.id, officeId: ctx.office.id },
      async (c) => {
        const r = await c.query<{ id: string }>('SELECT app.create_company($1, $2) AS id', [
          parsed.data.name,
          parsed.data.eik,
        ]);
        return r.rows[0]?.id;
      },
    );
    if (id) {
      const jar = await cookies();
      jar.set(COMPANY_COOKIE, id, COOKIE);
      jar.delete(PERIOD_COOKIE);
    }
    return id ? { id } : { error: 'Фирмата не беше създадена.' };
  } catch (err) {
    if (err instanceof DatabaseError && (err.code === '42501' || err.code === '22023')) {
      return { error: err.message };
    }
    throw err;
  }
}

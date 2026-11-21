import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

/**
 * The tenant context of one request or job (ADR-0002).
 * `companyId` is optional: office-level screens (company list, users) have no company.
 */
export const TenantContext = z.object({
  userId: z.uuid(),
  officeId: z.uuid(),
  companyId: z.uuid().optional(),
  ip: z.union([z.ipv4(), z.ipv6()]).optional(),
});
export type TenantContext = z.infer<typeof TenantContext>;

/**
 * Runs `fn` in a transaction where only the signed-in user is known (no office yet):
 * registration and office selection right after sign-in. RLS still applies, so office
 * and company data stay invisible; only app.register_office / app.my_offices are useful.
 */
export async function withUser<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const id = z.uuid().parse(userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [id]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` inside a transaction with the tenant context set via set_config(..., true)
 * (equivalent to SET LOCAL: the values vanish at COMMIT/ROLLBACK, so pooled connections
 * never leak context). This is the ONLY way application code may touch tenant data.
 */
export async function withTenant<T>(
  pool: Pool,
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = TenantContext.parse(ctx);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.office_id', $2, true),
              set_config('app.company_id', $3, true),
              set_config('app.ip', $4, true)`,
      [c.userId, c.officeId, c.companyId ?? '', c.ip ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

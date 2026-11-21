/** Legal parameters in the database (PROMPT.md 3.1). */
import { BGN_PER_EUR } from '@kantora/domain';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe('legal parameters', () => {
  it('the code constant for BGN/EUR equals the sourced parameter', async () => {
    const r = await app.query<{ v: string }>(
      `SELECT app.legal_numeric('eur_bgn_conversion_rate', DATE '2026-01-01')::text AS v`,
    );
    expect(Number(r.rows[0]!.v)).toBe(Number(BGN_PER_EUR.toString()));
    expect(r.rows[0]!.v.replace(/0+$/, '')).toBe(BGN_PER_EUR.toString());
  });

  it('there is no value before the date it took effect', async () => {
    const r = await app.query<{ v: string | null }>(
      `SELECT app.legal_numeric('eur_bgn_conversion_rate', DATE '2025-12-31') AS v`,
    );
    expect(r.rows[0]!.v).toBeNull();
  });

  it('every parameter has a source and a verification date', async () => {
    const r = await app.query<{ key: string }>(
      `SELECT key FROM app.legal_parameter
       WHERE coalesce(source_url, '') = '' OR coalesce(source_ref, '') = '' OR verified_at IS NULL`,
    );
    expect(r.rows).toEqual([]);
  });

  it('the application cannot change legal parameters', async () => {
    await expect(
      app.query(
        `UPDATE app.legal_parameter SET value_numeric = 2 WHERE key = 'eur_bgn_conversion_rate'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query(
        `INSERT INTO app.legal_parameter (key, value_numeric, valid_from, source_url, source_ref, verified_at)
         VALUES ('x', 1, DATE '2026-01-01', 'u', 'r', DATE '2026-01-01')`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('overlapping versions of the same key are rejected by the database', async () => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.system_actor', 'test', true)`);
      await expect(
        c.query(
          `INSERT INTO app.legal_parameter (key, value_numeric, valid_from, source_url, source_ref, verified_at)
           VALUES ('eur_bgn_conversion_rate', 2, DATE '2027-01-01', 'u', 'r', DATE '2026-01-01')`,
        ),
      ).rejects.toThrow(/legal_parameter_no_overlap/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

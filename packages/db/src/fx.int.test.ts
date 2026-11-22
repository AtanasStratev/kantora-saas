/**
 * BNB rates in the database: readable by every user, written only through
 * app.store_bnb_rates (checked, idempotent, never overwritten), audited.
 *
 * Stored rates are immutable, so every test runs in ONE transaction that is rolled back:
 * no fake rate ever stays in the database (a later real import would conflict with it).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => {
  await admin.end();
});

const SRC = 'https://www.bnb.bg/Statistics/test';
const lev = (currency: string, rate: string, units = 1) => ({
  currency,
  kind: 'bgn_per_units',
  rate,
  units,
});

type Tx = {
  /** Runs SQL as the application role with `userId` in the context (savepoint per call). */
  asApp: (userId: string, sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  asAdmin: (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
  user: () => Promise<string>;
  freeDays: string[];
};

async function rolledBack(fn: (tx: Tx) => Promise<void>) {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    const freeDays = (
      await c.query<{ d: string }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS d
         FROM generate_series(DATE '2000-01-01', DATE '2019-12-31', interval '1 day') d
         WHERE NOT EXISTS (SELECT 1 FROM app.exchange_rate_day x WHERE x.rate_date = d::date)
         ORDER BY random() LIMIT 20`,
      )
    ).rows.map((r) => r.d);
    let n = 0;
    const tx: Tx = {
      freeDays,
      asAdmin: (sql, params) => c.query(sql, params),
      user: async () => {
        const id = randomUUID();
        await c.query(
          'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
          [id, 'Т', `${id}@test.local`],
        );
        return id;
      },
      asApp: async (userId, sql, params) => {
        const sp = `s${++n}`;
        await c.query(`SAVEPOINT ${sp}`);
        try {
          await c.query('SET LOCAL ROLE app_user');
          await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
          const r = await c.query(sql, params);
          await c.query('RESET ROLE');
          await c.query(`RELEASE SAVEPOINT ${sp}`);
          return r;
        } catch (err) {
          await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await c.query('RESET ROLE');
          throw err;
        }
      },
    };
    await fn(tx);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

const store = (tx: Tx, userId: string, date: string, status: string, rates: object[]) =>
  tx.asApp(userId, 'SELECT app.store_bnb_rates($1, $2, $3, $4)', [
    date,
    status,
    SRC,
    JSON.stringify(rates),
  ]);

describe('BNB rates storage', () => {
  it('stores a day, is idempotent, refuses different data and any change', () =>
    rolledBack(async (tx) => {
      const [d0 = '', d1 = '', d2 = ''] = tx.freeDays;
      const u = await tx.user();
      const rates = [lev('USD', '1.70123'), lev('JPY', '1.12345', 100)];
      await store(tx, u, d0, 'published', rates);
      await store(tx, u, d0, 'published', rates); // the same again: fine
      await expect(store(tx, u, d0, 'published', [lev('USD', '1.70124')])).rejects.toThrow(
        /вече има записани различни данни/,
      );
      await store(tx, u, d1, 'none', []);

      // Any other user reads the same reference data.
      const other = await tx.user();
      const seen = await tx.asApp(
        other,
        'SELECT currency, rate::text, units FROM app.exchange_rate WHERE rate_date = $1 ORDER BY currency',
        [d0],
      );
      expect(seen.rows).toEqual([
        { currency: 'JPY', rate: '1.12345', units: 100 },
        { currency: 'USD', rate: '1.70123', units: 1 },
      ]);

      // The application cannot write the tables directly; nobody can change stored rates.
      await expect(
        tx.asApp(
          u,
          `INSERT INTO app.exchange_rate_day (rate_date, status, source_url) VALUES ($1, 'none', $2)`,
          [d2, SRC],
        ),
      ).rejects.toThrow(/permission denied/);
      await tx.asAdmin('SAVEPOINT upd');
      await expect(
        tx.asAdmin(`UPDATE app.exchange_rate SET rate = 2 WHERE rate_date = $1`, [d0]),
      ).rejects.toThrow(/не се променят/);
      await tx.asAdmin('ROLLBACK TO SAVEPOINT upd');

      // Audited with the acting user.
      const audit = await tx.asAdmin(
        `SELECT count(*)::int AS n FROM app.audit_log WHERE table_name = 'exchange_rate' AND user_id = $1`,
        [u],
      );
      expect(audit.rows[0]).toEqual({ n: 2 });
    }));

  it('refuses inconsistent data', () =>
    rolledBack(async (tx) => {
      const u = await tx.user();
      const d = (i: number) => tx.freeDays[i] ?? '';
      const bad = (date: string, status: string, rates: object[]) =>
        expect(store(tx, u, date, status, rates)).rejects.toThrow();
      await bad(d(3), 'published', []); // published without rates
      await bad(d(4), 'none', [lev('USD', '1.7')]); // "none" with rates
      await bad(d(5), 'published', [{ currency: 'USD', kind: 'per_eur', rate: '1.1' }]); // euro quote in the lev era
      await bad(d(6), 'published', [lev('usd', '1.7')]);
      await bad(d(7), 'published', [lev('USD', '0')]);
      await bad(d(8), 'published', [lev('EUR', '1.95583')]); // EUR is not a foreign rate here
      await bad('2999-01-01', 'published', [{ currency: 'USD', kind: 'per_eur', rate: '1.1' }]);
      // A "none" for today is refused: the BNB may still publish later today.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
        new Date(),
      );
      await bad(today, 'none', []);
      // Without a user in the context nothing is stored.
      await expect(
        tx.asApp('', 'SELECT app.store_bnb_rates($1, $2, $3, $4)', [d(9), 'none', SRC, '[]']),
      ).rejects.toThrow();
    }));
});

describe('lev/euro rate under the currency board (legal_parameter)', () => {
  it('is 1.95583 from 2000 to 2025 and undefined outside (no guessing)', async () => {
    const v = async (d: string) =>
      (
        await admin.query<{ v: string | null }>(
          `SELECT app.legal_numeric('bgn_per_eur_currency_board', $1)::text AS v`,
          [d],
        )
      ).rows[0]?.v;
    expect(await v('2000-01-01')).toBe('1.9558300000');
    expect(await v('2025-12-31')).toBe('1.9558300000');
    expect(await v('1999-12-31')).toBeNull(); // the 1999 denomination is not verified yet
    expect(await v('2026-01-01')).toBeNull(); // from 2026 the books are in euro
  });
});

describe('ECB-sourced rows (store_fx_rates)', () => {
  const eur = (currency: string, rate: string) => ({ currency, kind: 'per_eur', rate, units: 1 });
  const fx = (
    tx: Tx,
    userId: string,
    date: string,
    status: string,
    source: string,
    url: string,
    sourceDate: string | null,
    rates: object[],
  ) =>
    tx.asApp(userId, 'SELECT app.store_fx_rates($1, $2, $3, $4, $5, $6)', [
      date,
      status,
      source,
      url,
      sourceDate,
      JSON.stringify(rates),
    ]);
  const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';

  it('stores the rate that applies to a day with its ECB day; refuses inconsistent rows', () =>
    rolledBack(async (tx) => {
      const free = (
        await tx.asAdmin(
          `SELECT to_char(d, 'YYYY-MM-DD') AS d
           FROM generate_series(DATE '2026-01-01', (now() AT TIME ZONE 'Europe/Sofia')::date - 1, interval '1 day') d
           WHERE NOT EXISTS (SELECT 1 FROM app.exchange_rate_day x WHERE x.rate_date = d::date)
             AND extract(isodow FROM d) < 6
           ORDER BY d DESC LIMIT 6`,
        )
      ).rows.map((r: { d: string }) => r.d);
      const [d0 = '', d1 = '', d2 = '', d3 = ''] = free;
      const u = await tx.user();
      const prev = (d: string) => {
        const x = new Date(`${d}T12:00:00Z`);
        x.setUTCDate(x.getUTCDate() - 1);
        return x.toISOString().slice(0, 10);
      };

      await fx(tx, u, d0, 'published', 'ecb', ECB, prev(d0), [eur('USD', '1.099')]);
      const row = await tx.asAdmin(
        `SELECT source, to_char(source_date, 'YYYY-MM-DD') AS sd FROM app.exchange_rate_day WHERE rate_date = $1`,
        [d0],
      );
      expect(row.rows[0]).toEqual({ source: 'ecb', sd: prev(d0) });
      // The same rates again from the BNB are accepted (1.0990 = 1.099); different ones not.
      await fx(tx, u, d0, 'published', 'bnb', 'https://www.bnb.bg/x', null, [eur('USD', '1.0990')]);
      await expect(
        fx(tx, u, d0, 'published', 'bnb', 'https://www.bnb.bg/x', null, [eur('USD', '1.1')]),
      ).rejects.toThrow(/различни данни/);

      const bad = (p: Promise<unknown>) => expect(p).rejects.toThrow();
      await bad(
        fx(tx, u, d1, 'published', 'ecb', ECB, d0 > d1 ? d0 : '2099-01-01', [eur('USD', '1.1')]),
      ); // ECB day after the date
      await bad(fx(tx, u, d2, 'none', 'ecb', ECB, d2, [])); // ECB rows are always "published"
      await bad(
        fx(tx, u, d3, 'published', 'ecb', 'https://evil.example/x', d3, [eur('USD', '1.1')]),
      );
      await bad(
        fx(tx, u, '2025-12-30', 'published', 'ecb', ECB, '2025-12-30', [eur('USD', '1.1')]),
      ); // lev era
    }));
});

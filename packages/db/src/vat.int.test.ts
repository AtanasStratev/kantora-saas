/**
 * VAT documents in the DATABASE (migration 20261128100000, ADR-0018): posting with its
 * entry, the rate checked against legal_parameter on the tax event date, immutability,
 * roles and isolation. The rate used here is a FICTITIOUS test parameter (10 %), created
 * for the test and removed afterwards; real rates come only from an official source.
 */
import { lineVat } from '@kantora/domain';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticReport } from './analytic-reports';
import { trialBalance } from './reports';
import { postVatDocument, saveVatSettings, vatDocuments, vatRates } from './vat';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
const RATE = `vat_rate_test_${randomBytes(4).toString('hex')}`;
const YEAR = new Date().getFullYear();
const day = (m: number, d: number) =>
  `${YEAR}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

type Ctx = TenantContext & { companyId: string };
let owner: Ctx;
const acc: Record<string, string> = {};
let cp: string;
let periods: Record<number, string> = {};

async function company(): Promise<Ctx> {
  const userId = randomUUID();
  await admin.query(
    'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
    [userId, 'Т', `${userId}@test.local`],
  );
  const officeId = await withUser(
    app,
    userId,
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.register_office('ДДС') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('ДДС ООД') AS id`)).rows[0]!.id,
  );
  return { userId, officeId, companyId };
}

beforeAll(async () => {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.system_actor', 'test-vat', true)`);
    await c.query(
      `INSERT INTO app.legal_parameter (key, value_numeric, valid_from, valid_to, source_url, source_ref, verified_at)
       VALUES ($1, 10, $2, $3, 'https://test.invalid', 'ТЕСТ: измислена ставка', CURRENT_DATE)`,
      [RATE, day(1, 1), day(6, 30)],
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  owner = await company();
  await withTenant(app, owner, async (c) => {
    for (const [code, needs] of [
      ['401', true],
      ['411', true],
      ['4531', false],
      ['4532', false],
      ['601', false],
      ['703', false],
    ] as const) {
      acc[code] = (
        await c.query<{ id: string }>(
          `INSERT INTO app.account (office_id, company_id, code, name, needs_counterparty, needs_document)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [owner.officeId, owner.companyId, code, `Сметка ${code}`, needs],
        )
      ).rows[0]!.id;
    }
    cp = (
      await c.query<{ id: string }>(
        `INSERT INTO app.counterparty (office_id, company_id, name) VALUES ($1, $2, 'Доставчик') RETURNING id`,
        [owner.officeId, owner.companyId],
      )
    ).rows[0]!.id;
    periods = Object.fromEntries(
      (await c.query<{ id: string; month: number }>('SELECT id, month FROM app.period')).rows.map(
        (p) => [p.month, p.id],
      ),
    );
  });
});

afterAll(async () => {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.system_actor', 'test-vat', true)`);
    await c.query('DELETE FROM app.legal_parameter WHERE key = $1', [RATE]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  await Promise.all([admin.end(), app.end()]);
});

const doc = (over: Partial<Parameters<typeof postVatDocument>[2]> = {}) => ({
  direction: 'purchase' as const,
  kind: 'invoice' as const,
  number: '0000000001',
  issueDate: day(3, 5),
  taxEventDate: day(3, 5),
  counterpartyId: cp,
  relatedId: null,
  lines: [
    {
      accountId: acc['601']!,
      description: 'Материали',
      net: '100.00',
      rateKey: RATE,
      vat: '10.00',
    },
  ],
  ...over,
});

describe('VAT documents', () => {
  it('lists only the rates valid on the date', async () => {
    const on = (d: string) => withTenant(app, owner, (c) => vatRates(c, d));
    expect((await on(day(3, 1))).find((r) => r.key === RATE)?.percent).toBe('10');
    expect((await on(day(7, 1))).find((r) => r.key === RATE)).toBeUndefined();
  });

  it('refuses to post without the VAT settings', async () => {
    const r = await postVatDocument(app, owner, doc());
    expect(r).toEqual({
      ok: false,
      problems: [
        'В настройките на ДДС липсва сметка за доставчиците.',
        'В настройките на ДДС липсва сметка за ДДС за покупките.',
      ],
    });
  });

  it('a purchase invoice posts its entry with the supplier analytics', async () => {
    await saveVatSettings(app, owner, {
      inputVatAccountId: acc['4531']!,
      outputVatAccountId: acc['4532']!,
      supplierAccountId: acc['401']!,
      customerAccountId: acc['411']!,
    });
    const r = await postVatDocument(app, owner, doc());
    if (!r.ok) throw new Error(r.problems.join(' '));
    const lines = await withTenant(
      app,
      owner,
      async (c) =>
        (
          await c.query<{
            code: string;
            side: string;
            amount: string;
            document_number: string | null;
          }>(
            `SELECT a.code, l.side, l.amount::text, l.document_number FROM app.journal_line l
           JOIN app.account a ON a.id = l.account_id WHERE l.entry_id = $1 ORDER BY l.line_no`,
            [r.entryId],
          )
        ).rows,
    );
    expect(lines.map((l) => [l.code, l.side, l.amount, l.document_number])).toEqual([
      ['601', 'D', '100.00', null],
      ['4531', 'D', '10.00', '0000000001'],
      ['401', 'C', '110.00', '0000000001'],
    ]);
    const rep = await analyticReport(app, owner, acc['401']!, 'document', periods[3]!, 3, 3);
    expect(rep.rows.map((x) => [x.document_number, x.closing])).toEqual([
      ['0000000001', '-110.00'],
    ]);
    expect((await trialBalance(app, owner, periods[3]!, 3, 3)).reconciled).toBe(true);
  });

  it('a credit note swaps the sides; a sale must carry the computed VAT', async () => {
    const [first] = await vatDocuments(app, owner, periods[3]!);
    const cn = await postVatDocument(
      app,
      owner,
      doc({
        kind: 'credit_note',
        number: '0000000002',
        relatedId: first!.id,
        lines: [{ ...doc().lines[0]!, net: '20.00', vat: '2.00' }],
      }),
    );
    expect(cn.ok).toBe(true);
    const sale = await postVatDocument(
      app,
      owner,
      doc({
        direction: 'sale',
        number: '0000000001',
        lines: [
          {
            accountId: acc['703']!,
            description: 'Услуга',
            net: '19.99',
            rateKey: RATE,
            vat: '1.99',
          },
        ],
      }),
    );
    expect(sale).toEqual({
      ok: false,
      problems: [
        `Ред 1: ДДС на продажба е ${lineVat('19.99', '10').replace('.', ',')} (по ставката).`,
      ],
    });
    const docs = await vatDocuments(app, owner, periods[3]!);
    expect(docs.map((d) => [d.direction, d.kind, d.net, d.vat])).toEqual([
      ['purchase', 'invoice', '100.00', '10.00'],
      ['purchase', 'credit_note', '20.00', '2.00'],
    ]);
  });

  it('the database refuses a rate without a verified parameter on the tax date', async () => {
    const r = await postVatDocument(
      app,
      owner,
      doc({ number: '0000000003', issueDate: day(7, 1), taxEventDate: day(7, 1) }),
    );
    expect(r).toEqual({
      ok: false,
      problems: [`Ред 1: няма проверена ставка „${RATE}“ към 01.07.${YEAR}.`],
    });
    // Directly in the database, bypassing the application: refused as well.
    await expect(
      withTenant(app, owner, async (c) => {
        const d = await c.query<{ id: string }>(
          `INSERT INTO app.vat_document (office_id, company_id, direction, kind, number, issue_date, tax_event_date, counterparty_id)
           VALUES ($1, $2, 'purchase', 'invoice', 'X-1', $3, $3, $4) RETURNING id`,
          [owner.officeId, owner.companyId, day(7, 1), cp],
        );
        await c.query(
          `INSERT INTO app.vat_document_line (office_id, company_id, document_id, line_no, account_id, net_amount, rate_key, rate_percent, vat_amount)
           VALUES ($1, $2, $3, 1, $4, 10, 'vat_rate_made_up', 20, 2)`,
          [owner.officeId, owner.companyId, d.rows[0]!.id, acc['601']],
        );
        const e = await c.query<{ id: string }>(
          `INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [owner.officeId, owner.companyId, periods[7], day(7, 1), owner.userId],
        );
        await c.query(
          `UPDATE app.vat_document SET status = 'posted', entry_id = $2 WHERE id = $1`,
          [d.rows[0]!.id, e.rows[0]!.id],
        );
      }),
    ).rejects.toThrow('Ред 1: няма проверена ставка „vat_rate_made_up“');
  });

  it('a posted document never changes; the same supplier number is refused', async () => {
    const [first] = await vatDocuments(app, owner, periods[3]!);
    await expect(
      withTenant(app, owner, (c) =>
        c.query(`UPDATE app.vat_document SET number = 'Y' WHERE id = $1`, [first!.id]),
      ),
    ).rejects.toThrow('Осчетоводен документ не се променя.');
    await expect(
      withTenant(app, owner, (c) =>
        c.query(`DELETE FROM app.vat_document_line WHERE document_id = $1`, [first!.id]),
      ),
    ).rejects.toThrow('Осчетоводен документ не се променя.');
    expect(await postVatDocument(app, owner, doc())).toEqual({
      ok: false,
      problems: ['Документ с този номер вече има.'],
    });
  });
});

describe('roles and isolation', () => {
  it('payroll and another office see no VAT documents; read-only cannot post', async () => {
    const member = async (role: string): Promise<Ctx> => {
      const userId = randomUUID();
      await admin.query(
        'INSERT INTO auth."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)',
        [userId, 'Т', `${userId}@test.local`],
      );
      const token = randomBytes(16).toString('hex');
      await withTenant(app, owner, (c) =>
        c.query(
          'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
          [
            owner.officeId,
            `${userId}@test.local`,
            role,
            createHash('sha256').update(token).digest(),
            owner.userId,
          ],
        ),
      );
      await withUser(app, userId, (c) => c.query('SELECT app.accept_invitation($1)', [token]));
      await withTenant(app, owner, (c) =>
        c.query('INSERT INTO app.company_access VALUES ($1, $2, $3)', [
          owner.officeId,
          userId,
          owner.companyId,
        ]),
      );
      return { userId, officeId: owner.officeId, companyId: owner.companyId };
    };
    const seen = (ctx: Ctx) =>
      withTenant(app, ctx, async (c) => (await c.query('SELECT 1 FROM app.vat_document')).rowCount);
    expect(await seen(await member('payroll'))).toBe(0);
    const other = await company();
    expect(await seen({ ...other, companyId: owner.companyId })).toBe(0);
    const ro = await postVatDocument(app, await member('read_only'), doc({ number: 'RO-1' }));
    expect(ro).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/row-level security/)],
    });
  });
});

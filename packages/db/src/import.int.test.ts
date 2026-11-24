/**
 * Import from the Excel template, applied in the DATABASE (migration 20261127100000,
 * ADR-0017): preview = the same transaction rolled back; all or nothing; every problem
 * with its sheet and row; opening balances of a year; reconciliation with the trial
 * balance. Account codes and names are illustrative test data.
 */
import { parseImportWorkbook, type ImportCell, type ImportSheet } from '@kantora/domain';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticReport } from './analytic-reports';
import { applyImport } from './import';
import { trialBalance } from './reports';
import { withTenant, withUser, type TenantContext } from './tenant';

const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const YEAR = new Date().getFullYear();
const t = (value: string): ImportCell => ({ type: 'text', value });
const sh = (name: string, rows: string[][]): ImportSheet => ({
  name,
  rows: rows.map((r) => r.map((v) => (v === '' ? undefined : t(v)))),
});
const d = (m: number, day: number) =>
  `${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}.${YEAR}`;

type Ctx = TenantContext & { companyId: string };
let owner: Ctx;

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
      (await c.query<{ id: string }>(`SELECT app.register_office('Внос') AS id`)).rows[0]!.id,
  );
  const companyId = await withTenant(
    app,
    { userId, officeId },
    async (c) =>
      (await c.query<{ id: string }>(`SELECT app.create_company('Внос ООД') AS id`)).rows[0]!.id,
  );
  return { userId, officeId, companyId };
}

const workbook = () => [
  sh('Сметки', [
    ['Код', 'Наименование', 'Контрагент', 'Документ', 'Обект'],
    ['101', 'Основен капитал', '', '', ''],
    ['401', 'Доставчици', 'да', 'да', ''],
    ['503', 'Разплащателна сметка', '', '', ''],
    ['601', 'Разходи за материали', '', '', 'да'],
  ]),
  sh('Обекти', [
    ['Код', 'Наименование'],
    ['О1', 'Обект 1'],
  ]),
  sh('Контрагенти', [
    ['Наименование', 'ЕИК'],
    ['Доставчик А', ''],
  ]),
  sh('Начални салда', [
    ['Сметка', 'Дебит', 'Кредит', 'Контрагент', 'Документ №'],
    ['503', '10 000,00', '', '', ''],
    ['401', '', '1 500,00', 'Доставчик А', 'Ф-0'],
    ['101', '', '8 500,00', '', ''],
  ]),
  sh('Статии', [
    [
      'Статия',
      'Дата',
      'Основание',
      'Сметка',
      'Дебит',
      'Кредит',
      'Контрагент',
      'Документ №',
      'Обект',
    ],
    ['B', d(3, 20), 'Плащане', '401', '1500', '', 'доставчик а', 'Ф-0', ''],
    ['B', d(3, 20), 'Плащане', '503', '', '1500', '', '', ''],
    ['A', d(2, 10), 'Материали', '601', '120,50', '', '', '', 'О1'],
    ['A', d(2, 10), 'Материали', '401', '', '120,50', 'Доставчик А', 'Ф-1', ''],
  ]),
];

const run = (ctx: Ctx, sheets: ImportSheet[], commit: boolean, openingYear: number | null = YEAR) =>
  applyImport(app, ctx, parseImportWorkbook(sheets), {
    commit,
    fileName: 'внос.xlsx',
    sha256: createHash('sha256').update(JSON.stringify(sheets)).digest('hex'),
    openingYear,
  });

const count = (ctx: Ctx, table: string) =>
  withTenant(app, ctx, async (c) =>
    Number((await c.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),
  );

beforeAll(async () => {
  owner = await company();
});

describe('import from the template', () => {
  it('the preview reports what will be imported and writes nothing', async () => {
    const r = await run(owner, workbook(), false);
    expect(r).toMatchObject({
      ok: true,
      committed: false,
      summary: {
        accounts: { added: 4, existing: 0 },
        objects: { added: 1 },
        counterparties: { added: 1 },
        opening: { lines: 3, year: YEAR },
        entries: { posted: 2 },
      },
    });
    expect(await count(owner, 'account')).toBe(0);
    expect(await count(owner, 'journal_entry')).toBe(0);
    expect(await count(owner, 'import_run')).toBe(0);
  });

  it('the import posts everything; opening balances and turnover reconcile with the file', async () => {
    const r = await run(owner, workbook(), true);
    expect(r.ok && r.committed).toBe(true);
    const periods = await withTenant(app, owner, async (c) =>
      Object.fromEntries(
        (await c.query<{ id: string; month: number }>('SELECT id, month FROM app.period')).rows.map(
          (p) => [p.month, p.id],
        ),
      ),
    );
    const tb = await trialBalance(app, owner, periods[12] ?? '', 1, 12);
    expect(tb.reconciled).toBe(true);
    const row = (code: string) => tb.rows.find((x) => x.code === code);
    // Opening from the file; turnover from the two entries.
    expect([row('503')?.od, row('503')?.tc, row('503')?.cd]).toEqual([
      '10000.00',
      '1500.00',
      '8500.00',
    ]);
    expect([row('401')?.oc, row('401')?.td, row('401')?.tc, row('401')?.cc]).toEqual([
      '1500.00',
      '1500.00',
      '120.50',
      '120.50',
    ]);
    // Numbers follow the dates: A (February) is №… before B (March); both point to the run.
    const entries = await withTenant(
      app,
      owner,
      async (c) =>
        (
          await c.query<{ number: number; description: string; import_run_id: string | null }>(
            `SELECT number, description, import_run_id FROM app.journal_entry ORDER BY number`,
          )
        ).rows,
    );
    expect(entries.map((e) => e.description)).toEqual([
      `Начални салда към 01.01.${YEAR} (внос)`,
      'Материали',
      'Плащане',
    ]);
    expect(new Set(entries.map((e) => e.import_run_id)).size).toBe(1);
    // The supplier by document: Ф-0 paid, Ф-1 open.
    const accounts = await withTenant(
      app,
      owner,
      async (c) =>
        (await c.query<{ id: string }>(`SELECT id FROM app.account WHERE code = '401'`)).rows[0]!
          .id,
    );
    const rep = await analyticReport(app, owner, accounts, 'document', periods[12] ?? '', 1, 12);
    expect(rep.reconciled).toBe(true);
    expect(rep.rows.map((x) => [x.document_number, x.closing])).toEqual([
      ['Ф-0', '0.00'],
      ['Ф-1', '-120.50'],
    ]);
  });

  it('a second import keeps existing accounts and refuses a second set of opening balances', async () => {
    const r = await run(owner, workbook(), true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.summary.accounts).toEqual({ added: 0, existing: 4 });
    expect(r.issues).toContainEqual({
      sheet: 'Начални салда',
      row: 2,
      message: expect.stringMatching(
        /^Начални салда: Годината вече има начални салда \(статия № 1\)/,
      ),
    });
    // All or nothing: the two entries of the file were not posted again.
    expect(await count(owner, 'journal_entry')).toBe(3);
  });

  it('every problem is reported with its sheet and row, and nothing is written', async () => {
    const other = await company();
    const r = await run(
      other,
      [
        sh('Сметки', [
          ['Код', 'Наименование', 'Контрагент'],
          ['401', 'Доставчици', 'да'],
          ['601', 'Разходи', ''],
        ]),
        sh('Статии', [
          ['Статия', 'Дата', 'Сметка', 'Дебит', 'Кредит', 'Контрагент'],
          ['1', d(4, 1), '601', '10', '', ''],
          ['1', d(4, 1), '999', '', '10', ''],
          ['2', d(4, 2), '601', '10', '', ''],
          ['2', d(4, 2), '401', '', '10', 'Непознат'],
          ['3', d(4, 3), '601', '10', '', ''],
          ['3', d(4, 3), '401', '', '10', ''],
          ['4', `01.04.${YEAR - 5}`, '601', '10', '', ''],
          ['4', `01.04.${YEAR - 5}`, '601', '', '10', ''],
        ]),
      ],
      true,
      null,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.sheet}:${i.row}:${i.message}`)).toEqual([
      'Статии:3:Няма сметка 999 (добавете я на листа „Сметки“ или в сметкоплана).',
      'Статии:5:Няма контрагент „Непознат“.',
      'Статии:7:Статия 3: сметка 401 изисква контрагент.',
      `Статии:8:Статия 4: фирмата няма период за 01.04.${YEAR - 5}.`,
    ]);
    expect(await count(other, 'account')).toBe(0);
  });

  it('only owner and chief accountant may import', async () => {
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
          'accountant',
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
    await expect(
      run({ userId, officeId: owner.officeId, companyId: owner.companyId }, workbook(), false),
    ).rejects.toThrow(/row-level security/);
  });
});

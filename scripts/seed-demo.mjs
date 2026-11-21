// Demo data for local development (PROMPT.md Фаза 1: "една команда за демо данни").
// Requires the app running (pnpm dev): users are created through the real sign-up and
// 2FA endpoints, so they are exactly like real accounts. Business data goes through the
// same database functions and RLS as the app (role kantora_app), never around them.
//
// Idempotent: if the demo owner already exists, nothing is changed.
// All names are invented; no EIKs are set (their checksum rules come with Phase 2).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { totp } from './dev-totp.mjs';

process.loadEnvFile('.env');
const BASE = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
const PASSWORD = process.env.DEV_DEMO_PASSWORD;
if (!PASSWORD || PASSWORD.length < 12) {
  console.error('DEV_DEMO_PASSWORD липсва в .env (виж .env.example).');
  process.exit(1);
}

const PEOPLE = [
  { key: 'owner', email: 'demo-owner@kantora.test', name: 'Демо Собственик', role: 'owner' },
  { key: 'chief', email: 'demo-chief@kantora.test', name: 'Демо Главен', role: 'chief_accountant' },
  {
    key: 'accountant',
    email: 'demo-accountant@kantora.test',
    name: 'Демо Счетоводител',
    role: 'accountant',
  },
  { key: 'payroll', email: 'demo-trz@kantora.test', name: 'Демо ТРЗ', role: 'payroll' },
];
const COMPANIES = [
  'Алфа Строй ООД',
  'Бета Трейд ЕООД',
  'Гама Консулт АД',
  'Делта Логистик ЕООД',
  'Епсилон ЕТ',
];

class Jar {
  cookies = new Map();
  take(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function api(jar, path, body) {
  const res = await fetch(`${BASE}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, cookie: jar.header() },
    body: JSON.stringify(body),
  });
  jar.take(res);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function createUser(p) {
  const jar = new Jar();
  const up = await api(jar, '/sign-up/email', { name: p.name, email: p.email, password: PASSWORD });
  if (up.status !== 200) {
    if (up.data?.code?.startsWith('USER_ALREADY_EXISTS')) return null;
    throw new Error(`sign-up ${p.email}: ${up.status} ${JSON.stringify(up.data)}`);
  }
  const en = await api(jar, '/two-factor/enable', { password: PASSWORD });
  if (en.status !== 200)
    throw new Error(`2FA enable ${p.email}: ${en.status} ${JSON.stringify(en.data)}`);
  const secret = new URL(en.data.totpURI).searchParams.get('secret');
  const ver = await api(jar, '/two-factor/verify-totp', { code: totp(secret) });
  if (ver.status !== 200)
    throw new Error(`2FA verify ${p.email}: ${ver.status} ${JSON.stringify(ver.data)}`);
  return { ...p, id: up.data.user.id, secret, backupCodes: en.data.backupCodes };
}

const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
async function as(ctx, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.office_id', $2, true),
              set_config('app.company_id', $3, true)`,
      [ctx.userId, ctx.officeId ?? '', ctx.companyId ?? ''],
    );
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

try {
  await fetch(`${BASE}/login`).catch(() => {
    throw new Error(`Приложението не отговаря на ${BASE}. Пуснете първо: pnpm dev`);
  });

  const users = {};
  for (const p of PEOPLE) {
    const u = await createUser(p);
    if (!u) {
      console.log(`Демо данните вече са създадени (${p.email} съществува). Нищо не е променено.`);
      process.exit(0);
    }
    users[p.key] = u;
  }
  const owner = users.owner;

  const officeId = await as(
    { userId: owner.id },
    async (c) => (await c.query(`SELECT app.register_office('Демо кантора') AS id`)).rows[0].id,
  );
  const ownerCtx = { userId: owner.id, officeId };

  for (const p of PEOPLE.filter((x) => x.key !== 'owner')) {
    const token = randomBytes(32).toString('base64url');
    await as(ownerCtx, (c) =>
      c.query(
        'INSERT INTO app.invitation (office_id, email, role, token_hash, invited_by) VALUES ($1, $2, $3, $4, $5)',
        [officeId, p.email, p.role, createHash('sha256').update(token).digest(), owner.id],
      ),
    );
    await as({ userId: users[p.key].id }, (c) =>
      c.query('SELECT app.accept_invitation($1)', [token]),
    );
  }

  const companyIds = [];
  for (const name of COMPANIES) {
    companyIds.push(
      await as(
        ownerCtx,
        async (c) => (await c.query('SELECT app.create_company($1) AS id', [name])).rows[0].id,
      ),
    );
  }

  // The accountant works on the first three companies; the chief and payroll on all.
  for (const [who, ids] of [
    ['accountant', companyIds.slice(0, 3)],
    ['chief', companyIds],
    ['payroll', companyIds],
  ]) {
    for (const id of ids) {
      await as(ownerCtx, (c) =>
        c.query('INSERT INTO app.company_access VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
          officeId,
          users[who].id,
          id,
        ]),
      );
    }
  }

  // A pre-euro year (BGN) for the first company, to show the ledger currency per year.
  await as({ ...ownerCtx, companyId: companyIds[0] }, async (c) => {
    const fy = await c.query(
      `INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
       VALUES ($1, $2, 2025, DATE '2025-01-01', DATE '2025-12-31', 'BGN') RETURNING id`,
      [officeId, companyIds[0]],
    );
    for (let m = 1; m <= 12; m++) {
      await c.query(
        `INSERT INTO app.period (office_id, company_id, fiscal_year_id, month, start_date, end_date)
         VALUES ($1, $2, $3, $4, make_date(2025, $4, 1), (make_date(2025, $4, 1) + interval '1 month - 1 day')::date)`,
        [officeId, companyIds[0], fy.rows[0].id, m],
      );
    }
  });

  mkdirSync('db/dev', { recursive: true });
  const out = 'db/dev/demo-accounts.local.json';
  writeFileSync(
    out,
    JSON.stringify(
      Object.values(users).map((u) => ({ email: u.email, role: u.role, totpSecret: u.secret })),
      null,
      2,
    ),
  );
  console.log(`Демо кантора: ${COMPANIES.length} фирми, ${PEOPLE.length} потребители.`);
  console.log(`Парола: DEV_DEMO_PASSWORD от .env. 2FA тайните са в ${out} (не се качва в Git).`);
  console.log('Текущ код за вход: node scripts/dev-totp.mjs <totpSecret>');
} finally {
  await pool.end();
}

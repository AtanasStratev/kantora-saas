// Restore rehearsal (PROMPT.md 3.4, docs/runbooks/restore.md): back up the database,
// restore it into a fresh scratch database and prove the copy is complete and intact.
// Fails (exit 1) on any difference. Safe: never touches the source database's data.
//
//   pnpm db:restore-check
//
// Uses the PostgreSQL 17 client tools from the docker compose service when it runs,
// otherwise a throwaway postgres:17 container on the host network (CI).
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import pg from 'pg';

if (process.env.CI !== 'true') process.loadEnvFile('.env');
const SOURCE_URL = process.env.DATABASE_URL;
const url = new URL(SOURCE_URL);
const SOURCE_DB = url.pathname.slice(1);
const SCRATCH_DB = `${SOURCE_DB}_restore_check`;
const DUMP = 'backups/restore-check.dump';

function composeRunning() {
  try {
    return execSync('docker compose ps --status running --services', { encoding: 'utf8' })
      .split('\n')
      .includes('postgres');
  } catch {
    return false;
  }
}

/** Runs a PostgreSQL client tool (pg_dump / pg_restore) with binary stdin/stdout. */
function pgTool(tool, args, input) {
  const env = ['-e', `PGPASSWORD=${decodeURIComponent(url.password)}`];
  const conn = [
    '-h',
    composeRunning() ? 'localhost' : url.hostname,
    '-p',
    url.port || '5432',
    '-U',
    decodeURIComponent(url.username),
  ];
  const cmd = composeRunning()
    ? ['compose', 'exec', '-T', ...env, 'postgres', tool, ...conn, ...args]
    : ['run', '--rm', '-i', '--network', 'host', ...env, 'postgres:17', tool, ...conn, ...args];
  return execFileSync('docker', cmd, { input, maxBuffer: 1024 * 1024 * 1024 });
}

async function withDb(dbUrl, fn) {
  const c = new pg.Client({ connectionString: dbUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Row count and an order-independent content hash for every table in app and auth. */
async function fingerprint(dbUrl) {
  return withDb(dbUrl, async (c) => {
    const tables = (
      await c.query(
        `SELECT table_schema || '.' || quote_ident(table_name) AS t FROM information_schema.tables
         WHERE table_schema IN ('app', 'auth') AND table_type = 'BASE TABLE' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    const out = {};
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*)::int AS n,
                coalesce(md5(string_agg(md5(x::text), '' ORDER BY md5(x::text))), '') AS h
         FROM ${t} x`,
      );
      out[t] = `${r.rows[0].n} rows, ${r.rows[0].h.slice(0, 12)}`;
    }
    return out;
  });
}

const report = [];
const ok = (msg) => report.push(`OK    ${msg}`);
const fail = (msg) => report.push(`FAIL  ${msg}`);
const started = Date.now();

try {
  // 1. Backup (custom format: compressed, restorable table by table).
  mkdirSync('backups', { recursive: true });
  const dump = pgTool('pg_dump', ['-Fc', '--no-owner', SOURCE_DB]);
  writeFileSync(DUMP, dump);
  const sha = createHash('sha256').update(readFileSync(DUMP)).digest('hex');
  ok(`backup ${DUMP}: ${(statSync(DUMP).size / 1024).toFixed(0)} KiB, sha256 ${sha.slice(0, 16)}…`);

  // 2. Restore into a fresh scratch database.
  await withDb(SOURCE_URL, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  pgTool('pg_restore', ['--no-owner', '--exit-on-error', '-d', SCRATCH_DB], readFileSync(DUMP));
  ok(`restored into ${SCRATCH_DB}`);
  const scratchUrl = new URL(SOURCE_URL);
  scratchUrl.pathname = `/${SCRATCH_DB}`;

  // 3. Every table: same rows, same content.
  const [a, b] = await Promise.all([fingerprint(SOURCE_URL), fingerprint(scratchUrl.href)]);
  const tables = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  const diff = tables.filter((t) => a[t] !== b[t]);
  if (diff.length) diff.forEach((t) => fail(`${t}: source ${a[t]} vs restored ${b[t]}`));
  else ok(`${tables.length} tables identical (row counts and content hashes)`);

  // 4. Integrity inside the copy: migrations, RLS, audit hash chains.
  await withDb(scratchUrl.href, async (c) => {
    const mig = (await c.query('SELECT count(*)::int AS n FROM public.schema_migrations')).rows[0]
      .n;
    ok(`${mig} migrations recorded`);
    const noRls = (
      await c.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      )
    ).rows;
    if (noRls.length)
      fail(`tables without FORCE RLS after restore: ${noRls.map((r) => r.relname)}`);
    else ok('row level security enabled and forced on every app table');
    const broken = (
      await c.query(
        `SELECT o.id, app.verify_audit_chain(o.id) AS broken FROM app.office o
         WHERE app.verify_audit_chain(o.id) IS NOT NULL`,
      )
    ).rows;
    const offices = (await c.query('SELECT count(*)::int AS n FROM app.office')).rows[0].n;
    if (broken.length) fail(`audit hash chain broken for offices: ${broken.map((r) => r.id)}`);
    else ok(`audit hash chain intact for all ${offices} offices`);
  });

  // 5. Clean up the scratch copy (the dump stays for inspection, ignored by git).
  await withDb(SOURCE_URL, (c) => c.query(`DROP DATABASE ${SCRATCH_DB} WITH (FORCE)`));
  ok(`scratch database dropped; total ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (e) {
  fail(e instanceof Error ? e.message.split('\n')[0] : String(e));
}

console.log(report.join('\n'));
const failed = report.some((l) => l.startsWith('FAIL'));
writeFileSync('backups/restore-check.log', `${new Date().toISOString()}\n${report.join('\n')}\n`);
if (failed) {
  console.error('\nRestore rehearsal FAILED.');
  process.exit(1);
}
rmSync(DUMP, { force: true });
console.log('\nRestore rehearsal passed.');

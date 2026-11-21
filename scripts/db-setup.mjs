// Local dev only: creates .env from .env.example, runs migrations and creates the
// application login role (member of app_user, no BYPASSRLS).
import { copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import pg from 'pg';

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example');
}
process.loadEnvFile('.env');

execSync('pnpm exec dbmate --no-dump-schema --wait up', { stdio: 'inherit' });

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kantora_app') THEN
        CREATE ROLE kantora_app LOGIN PASSWORD 'kantora_app_dev_only' NOBYPASSRLS IN ROLE app_user;
      END IF;
    END
    $$;`);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kantora_auth') THEN
        CREATE ROLE kantora_auth LOGIN PASSWORD 'kantora_auth_dev_only' NOBYPASSRLS;
      END IF;
    END
    $$;`);
  // Re-grant every time: rolling back migrations drops the group roles and their memberships.
  await client.query('GRANT app_user TO kantora_app');
  await client.query('GRANT auth_service TO kantora_auth');
  console.log('Application role kantora_app is ready.');
} finally {
  await client.end();
}

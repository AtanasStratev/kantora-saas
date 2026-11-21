import 'server-only';
import { Pool } from 'pg';
import { env } from './env';

/** Business-data pool: role kantora_app (member of app_user, no BYPASSRLS). */
export const appPool = new Pool({ connectionString: env.APP_DATABASE_URL, max: 10 });

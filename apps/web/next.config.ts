import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// Local development: share the repository-root .env with migrations and tests.
// Production gets its variables from the hosting environment, never from a file.
const rootEnv = resolve(process.cwd(), '../../.env');
if (process.env.NODE_ENV !== 'production' && existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  transpilePackages: ['@kantora/db', '@kantora/domain'],
  serverExternalPackages: ['@node-rs/argon2', 'pg'],
  poweredByHeader: false,
  // Project rules for AI assistants live in the root CLAUDE.md, not in a generated file.
  agentRules: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;

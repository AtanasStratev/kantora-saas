import 'server-only';
import { z } from 'zod';

/** Server environment, validated at startup (Zod at every boundary). */
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_DATABASE_URL: z.string().min(1),
  AUTH_DATABASE_URL: z.string().min(1),
  BETTER_AUTH_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
});
type Env = z.infer<typeof Env>;

/**
 * `next build` imports server modules to collect page data, but secrets are only present
 * at runtime (the hosting environment injects them). During the build phase we expose
 * inert placeholders that cannot connect anywhere; every runtime start validates for real.
 */
const BUILD_PLACEHOLDERS: Env = {
  NODE_ENV: 'production',
  APP_DATABASE_URL: 'postgres://build-placeholder.invalid/none',
  AUTH_DATABASE_URL: 'postgres://build-placeholder.invalid/none',
  BETTER_AUTH_URL: 'http://build-placeholder.invalid',
  BETTER_AUTH_SECRET: 'build-phase-placeholder-not-a-secret-0000',
};

export const env: Env =
  process.env.NEXT_PHASE === 'phase-production-build' ? BUILD_PLACEHOLDERS : Env.parse(process.env);

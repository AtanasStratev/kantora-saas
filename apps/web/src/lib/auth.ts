import 'server-only';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { Pool } from 'pg';
import { env } from './env';
import { sendMail, templates } from './mail';

/**
 * Authentication (ADR-0005). Better Auth owns only the `auth` schema and connects with
 * its own login role (kantora_auth), which has no rights on business data in `app`.
 */
const authPool = new Pool({
  connectionString: env.AUTH_DATABASE_URL,
  options: '-c search_path=auth',
  max: 5,
});

// Argon2id (OWASP recommended parameters: m=19 MiB, t=2, p=1).
const ARGON2 = {
  algorithm: 2 /* Argon2id */,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

// Production limits; multiplied only in development/e2e (env.ts forbids it in production).
const RL = env.AUTH_RATE_LIMIT_MULTIPLIER;

export const auth = betterAuth({
  appName: 'Кантора',
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: authPool,
  advanced: {
    database: { generateId: 'uuid' },
    useSecureCookies: env.NODE_ENV === 'production',
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    // No sign-in until the e-mail is confirmed: invitations rely on e-mail ownership.
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({ to: user.email, ...templates.resetPassword(user.name, url) });
    },
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    password: {
      hash: (password) => hash(password, ARGON2),
      verify: ({ hash: stored, password }) => verify(stored, password),
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({ to: user.email, ...templates.verifyEmail(user.name, url) });
    },
    sendOnSignUp: true,
    sendOnSignIn: true, // re-sends the link when an unverified user tries to sign in
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
  },
  session: {
    expiresIn: 60 * 60 * 12, // 12 h
    updateAge: 60 * 15,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
    window: 60,
    max: 100 * RL,
    customRules: {
      '/sign-in/email': { window: 60, max: 5 * RL },
      '/sign-up/email': { window: 60, max: 3 * RL },
      '/two-factor/*': { window: 60, max: 5 * RL },
      // Mail-sending endpoints: keep them from being used to spam an inbox.
      '/request-password-reset': { window: 60, max: 3 * RL },
      '/send-verification-email': { window: 60, max: 3 * RL },
    },
  },
  plugins: [twoFactor({ issuer: 'Кантора' }), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

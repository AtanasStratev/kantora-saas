import { readFileSync } from 'node:fs';
import type { TestUser } from './helpers';

/** The owner registered once in global-setup.ts. */
export function sharedOwner(): TestUser {
  return JSON.parse(readFileSync('test-results/.auth/owner-creds.json', 'utf8')) as TestUser;
}

export const OWNER_STATE = 'test-results/.auth/owner.json';

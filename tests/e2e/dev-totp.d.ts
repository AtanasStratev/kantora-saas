declare module '*/dev-totp.mjs' {
  export function totp(secret: string, now?: number): string;
}
declare module '*/mailpit.mjs' {
  export function latestLink(
    to: string,
    subject: string,
    opts?: { timeoutMs?: number; after?: number },
  ): Promise<string>;
}

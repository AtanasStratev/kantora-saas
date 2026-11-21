declare module '*/dev-totp.mjs' {
  export function totp(secret: string, now?: number): string;
}

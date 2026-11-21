/**
 * Validates a post-login redirect target: only same-site paths are allowed, so a link
 * like /login?next=https://evil.example cannot send users elsewhere (open redirect).
 */
export function safeNext(value: string | null | undefined, fallback = '/'): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}

import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

describe('safeNext (no open redirects)', () => {
  it.each([
    ['/invite/abc', '/invite/abc'],
    ['/', '/'],
    ['https://evil.example', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    [null, '/'],
  ])('%j → %j', (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

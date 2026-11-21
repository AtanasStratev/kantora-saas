/**
 * WCAG 2.2 contrast check for every theme (PROMPT.md 5.1, design-system.md §6).
 * Reads the token values straight from globals.css, so the CSS stays the single source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]),
  );
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = {
  light: block("[data-theme='light']"),
  dark: block("[data-theme='dark']"),
  black: block("[data-theme='black']"),
};

// [foreground, background, minimum ratio]: 4.5 for text, 3 for UI boundaries and focus.
const PAIRS: [string, string, number][] = [];
for (const bg of ['surface', 'surface-raised', 'surface-sunken', 'surface-selected']) {
  for (const fg of ['text', 'text-muted', 'accent', 'positive', 'negative', 'warning']) {
    PAIRS.push([fg, bg, 4.5]);
  }
  PAIRS.push(['focus', bg, 3], ['border-strong', bg, 3]);
}
PAIRS.push(['accent-text', 'accent', 4.5]);

describe('theme tokens meet WCAG AA', () => {
  for (const [name, tokens] of Object.entries(THEMES)) {
    it(`${name}: every text/background and boundary pair passes`, () => {
      const failures = PAIRS.filter(([fg, bg, min]) => {
        const a = tokens[fg];
        const b = tokens[bg];
        if (!a || !b) throw new Error(`${name}: missing token --${!a ? fg : bg}`);
        return contrast(a, b) < min;
      }).map(
        ([fg, bg, min]) =>
          `--${fg} on --${bg}: ${contrast(tokens[fg]!, tokens[bg]!).toFixed(2)} < ${min}`,
      );
      expect(failures).toEqual([]);
    });
  }

  it('the system-dark block matches the explicit dark theme', () => {
    const start = css.indexOf('@media (prefers-color-scheme: dark)');
    const sub = css.slice(start);
    const sys = Object.fromEntries(
      [...sub.slice(0, sub.indexOf('}\n}')).matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(
        (m) => [m[1]!, m[2]!.toLowerCase()],
      ),
    );
    expect(sys).toEqual(THEMES.dark);
  });
});

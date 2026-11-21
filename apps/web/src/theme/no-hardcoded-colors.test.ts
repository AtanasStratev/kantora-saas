/**
 * Components may use only semantic tokens (PROMPT.md 5.1). This fails on raw colors in
 * component code; the only place for literal colors is globals.css.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');
const RAW_COLOR =
  /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:bg|text|border|from|to|via|fill|stroke)-(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx|ts)$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

it('no component uses a hard-coded color', () => {
  const offenders = files(SRC).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => RAW_COLOR.test(line))
      .map(({ line, i }) => `${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`),
  );
  expect(offenders).toEqual([]);
});

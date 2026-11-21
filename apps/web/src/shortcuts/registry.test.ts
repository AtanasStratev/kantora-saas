import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from './registry';

// Keys the browser reserves or that users rely on (design-system.md §4).
const RESERVED = ['Ctrl+N', 'Ctrl+T', 'Ctrl+W', 'Ctrl+F', 'F5', 'F6', 'F11', 'F12', 'Ctrl+L'];

describe('shortcut registry', () => {
  it('has unique ids and unique key combinations', () => {
    const ids = SHORTCUTS.map((s) => s.id);
    const combos = SHORTCUTS.map((s) => s.keys.join(s.sequence ? ' ' : '+'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('uses no browser-reserved combination', () => {
    const combos = SHORTCUTS.filter((s) => !s.sequence).map((s) => s.keys.join('+'));
    expect(combos.filter((c) => RESERVED.includes(c))).toEqual([]);
  });

  it('every shortcut has a Bulgarian label', () => {
    for (const s of SHORTCUTS) expect(s.label).toMatch(/[а-я]/i);
  });
});

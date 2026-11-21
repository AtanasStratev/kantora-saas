/** Theme values shared by server and client (PROMPT.md 5.1, design-system.md §2). */
export const THEMES = ['system', 'light', 'dark', 'black'] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_COOKIE = 'kantora-theme';

export const THEME_LABEL: Record<Theme, string> = {
  system: 'Системна',
  light: 'Светла',
  dark: 'Тъмна',
  black: 'Черна',
};

export function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

/** Alt+T order: system → light → dark → black → system. */
export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length] ?? 'system';
}

/** `data-theme` attribute value; `undefined` lets the CSS follow the OS setting. */
export function themeAttr(t: Theme): string | undefined {
  return t === 'system' ? undefined : t;
}

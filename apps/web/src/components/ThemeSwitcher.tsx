'use client';
import * as RG from '@radix-ui/react-radio-group';
import { useEffect, useState } from 'react';
import { isTheme, THEME_COOKIE, THEME_LABEL, THEMES, type Theme } from '@/theme/theme';
import { applyTheme } from '@/theme/ThemeHotkey';

function readCookie(): Theme {
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]+)`));
  const v = m?.[1];
  return isTheme(v) ? v : 'system';
}

/** Radio group for the theme; arrow keys move between options (Radix). */
export function ThemeSwitcher() {
  const [theme, setThemeState] = useState<Theme>('system');
  useEffect(() => {
    setThemeState(readCookie());
    const obs = new MutationObserver(() => setThemeState(readCookie()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return (
    <RG.Root
      aria-label="Тема"
      value={theme}
      onValueChange={(v) => {
        if (!isTheme(v)) return;
        setThemeState(v);
        applyTheme(v);
      }}
      className="flex gap-2"
    >
      {THEMES.map((t) => (
        <RG.Item
          key={t}
          value={t}
          className="rounded border border-line-strong px-2 py-1 text-sm data-[state=checked]:border-accent data-[state=checked]:bg-surface-selected"
        >
          {THEME_LABEL[t]}
        </RG.Item>
      ))}
    </RG.Root>
  );
}

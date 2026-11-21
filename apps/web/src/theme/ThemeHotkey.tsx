'use client';
import { useEffect } from 'react';
import { setTheme } from './actions';
import { isTheme, nextTheme, themeAttr, THEME_COOKIE, type Theme } from './theme';

function currentTheme(): Theme {
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_COOKIE}=([^;]+)`));
  const v = m?.[1];
  return isTheme(v) ? v : 'system';
}

/** Applies a theme instantly in the page, then persists it. */
export function applyTheme(t: Theme): void {
  const attr = themeAttr(t);
  if (attr) document.documentElement.setAttribute('data-theme', attr);
  else document.documentElement.removeAttribute('data-theme');
  document.cookie = `${THEME_COOKIE}=${t}; path=/; max-age=31536000; samesite=lax`;
  void setTheme(t);
}

/**
 * Global Alt+T: cycles the theme. Also brings the cookie in line with the theme stored
 * for the user (e.g. after signing in on a new computer).
 */
export function ThemeHotkey({ stored }: { stored: Theme | null }) {
  useEffect(() => {
    if (stored && stored !== currentTheme()) applyTheme(stored);
  }, [stored]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyT' || e.key === 't')) {
        e.preventDefault();
        applyTheme(nextTheme(currentTheme()));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return null;
}

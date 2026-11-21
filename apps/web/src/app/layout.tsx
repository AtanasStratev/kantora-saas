import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';
import { auth } from '@/lib/auth';
import { storedTheme } from '@/theme/actions';
import { isTheme, themeAttr, THEME_COOKIE, type Theme } from '@/theme/theme';
import { ThemeHotkey } from '@/theme/ThemeHotkey';
import './globals.css';

export const metadata: Metadata = {
  title: 'Кантора',
  description: 'Облачна система за счетоводни кантори',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = isTheme(cookieTheme) ? cookieTheme : 'system';

  // The theme remembered for the signed-in user wins over this browser's cookie.
  let stored: Theme | null = null;
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user.twoFactorEnabled) {
    stored = await storedTheme(session.user.id);
  }
  const effective = stored ?? theme;

  return (
    <html lang="bg" data-theme={themeAttr(effective)}>
      <body className="min-h-screen">
        <ThemeHotkey stored={stored} />
        {children}
      </body>
    </html>
  );
}

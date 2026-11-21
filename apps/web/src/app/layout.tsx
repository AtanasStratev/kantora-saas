import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Кантора',
  description: 'Облачна система за счетоводни кантори',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="bg">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

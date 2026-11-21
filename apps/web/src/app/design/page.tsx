import { notFound } from 'next/navigation';
import { DesignShowcase } from './DesignShowcase';

export const metadata = { title: 'Дизайн система · Кантора' };

/**
 * Living design system (PROMPT.md 5.3): every component in every theme. Holds no data,
 * so it needs no login; it is hidden in production unless explicitly enabled.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === 'production' && process.env.DESIGN_PAGE !== '1') {
    notFound();
  }
  return <DesignShowcase />;
}

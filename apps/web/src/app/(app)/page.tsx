import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { periodLabel } from '@/lib/period';

export default async function HomePage() {
  const ctx = await getAppContext();
  if (ctx.companies.length === 0) {
    return (
      <EmptyState
        title="В кантората още няма фирми"
        next="Създайте първата фирма-клиент от страницата „Фирми“"
        shortcut="g f"
      />
    );
  }
  if (!ctx.company) {
    return (
      <EmptyState
        title="Изберете фирма, с която да работите"
        next="Търсене по име или ЕИК, на кирилица или латиница:"
        shortcut="Ctrl+Shift+K"
      />
    );
  }
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold">{ctx.company.name}</h1>
      <p className="mb-6 text-sm text-fg-muted">
        {ctx.company.eik ? `ЕИК ${ctx.company.eik} · ` : ''}
        {ctx.period ? `период ${periodLabel(ctx.period)}, ${ctx.period.ledgerCurrency}` : ''}
      </p>
      <EmptyState
        title="Счетоводните модули идват във Фаза 2"
        next="Засега: смяна на фирма, период и тема. Всички клавиши:"
        shortcut="?"
      />
    </div>
  );
}

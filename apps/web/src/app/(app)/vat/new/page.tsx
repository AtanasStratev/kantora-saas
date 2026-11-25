import { can, isRole } from '@kantora/domain';
import { withTenant } from '@kantora/db';
import Link from 'next/link';
import { EmptyState } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { appPool } from '@/lib/db';
import { loadAccounts, loadCounterparties } from '@/lib/ledger-data';
import { VatDocumentForm } from './VatDocumentForm';

/** Нов документ по ДДС (ADR-0018). */
export default async function NewVatDocumentPage() {
  const ctx = await getAppContext();
  const role = ctx.office?.role;
  if (!ctx.office || !ctx.company || !ctx.period) {
    return (
      <EmptyState title="Изберете фирма и период" next="Смяна на фирма:" shortcut="Ctrl+Shift+K" />
    );
  }
  if (!isRole(role) || !can(role, 'accounting.post')) {
    return (
      <EmptyState
        title="Нямате право да осчетоводявате"
        next="Обърнете се към собственика на кантората."
      />
    );
  }
  const tenant = { userId: ctx.user.id, officeId: ctx.office.id, companyId: ctx.company.id };
  const [accounts, counterparties, { rates, invoices }] = await Promise.all([
    loadAccounts(tenant),
    loadCounterparties(tenant),
    withTenant(appPool, tenant, async (c) => ({
      // Every VAT rate with its validity: the form shows those valid on the tax event date.
      rates: (
        await c.query<{
          key: string;
          percent: string;
          valid_from: string;
          valid_to: string | null;
          source_ref: string;
        }>(
          `SELECT key, trim_scale(value_numeric)::text AS percent, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                  to_char(valid_to, 'YYYY-MM-DD') AS valid_to, source_ref
           FROM app.legal_parameter WHERE key LIKE 'vat\\_rate\\_%' AND value_numeric IS NOT NULL
           ORDER BY value_numeric DESC`,
        )
      ).rows,
      invoices: (
        await c.query<{ id: string; direction: string; counterparty_id: string; number: string }>(
          `SELECT id, direction, counterparty_id, number FROM app.vat_document
           WHERE kind = 'invoice' AND status = 'posted' ORDER BY issue_date DESC LIMIT 2000`,
        )
      ).rows,
    })),
  ]);
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(
    new Date(),
  );
  const p = ctx.period;
  const first = `${p.year}-${String(p.month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(p.year, p.month, 0)).toISOString().slice(0, 10);

  return (
    <div className="max-w-6xl">
      <p className="mb-2 text-sm">
        <Link className="text-accent underline" href="/vat">
          ← Документи по ДДС
        </Link>
      </p>
      <h1 className="mb-1 text-xl font-semibold">Нов документ по ДДС — {ctx.company.name}</h1>
      <p className="mb-4 text-sm text-fg-muted">Сумите са в {p.ledgerCurrency}.</p>
      <VatDocumentForm
        accounts={accounts
          .filter((a) => a.isPostable && a.isActive)
          .map((a) => ({ id: a.id, label: `${a.code} ${a.name}` }))}
        counterparties={counterparties
          .filter((c) => c.isActive)
          .map((c) => ({ id: c.id, label: c.eik ? `${c.name} (${c.eik})` : c.name }))}
        rates={rates.map((r) => ({
          key: r.key,
          percent: r.percent,
          from: r.valid_from,
          to: r.valid_to,
          source: r.source_ref,
        }))}
        invoices={invoices.map((i) => ({
          id: i.id,
          direction: i.direction,
          counterpartyId: i.counterparty_id,
          number: i.number,
        }))}
        period={{ year: p.year, month: p.month, today: todayIso }}
        defaultDate={todayIso >= first && todayIso <= last ? todayIso : last}
      />
    </div>
  );
}

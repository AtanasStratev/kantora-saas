'use client';
import type { VatSettings } from '@kantora/domain';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorText, inputClass } from '@/components/ui';
import { saveVatAccounts } from '../../vat-actions';

const FIELDS = [
  ['supplierAccountId', 'Доставчици (покупки)'],
  ['inputVatAccountId', 'ДДС за покупките'],
  ['customerAccountId', 'Клиенти (продажби)'],
  ['outputVatAccountId', 'ДДС за продажбите'],
] as const;

export function VatSettingsForm({
  settings,
  accounts,
  canEdit,
}: {
  settings: VatSettings;
  accounts: { id: string; label: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState({
    supplierAccountId: settings.supplierAccountId ?? '',
    inputVatAccountId: settings.inputVatAccountId ?? '',
    customerAccountId: settings.customerAccountId ?? '',
    outputVatAccountId: settings.outputVatAccountId ?? '',
  });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setSaved(false);
        void saveVatAccounts(v).then((r) => {
          setBusy(false);
          if (r.error !== undefined) setError(r.error);
          else {
            setError('');
            setSaved(true);
            router.refresh();
          }
        });
      }}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {FIELDS.map(([key, label]) => (
          <div key={key} className="flex flex-col gap-1 text-xs text-fg-muted">
            <label htmlFor={`vatset-${key}`}>{label}</label>
            <select
              id={`vatset-${key}`}
              className={inputClass}
              value={v[key]}
              disabled={!canEdit}
              onChange={(e) => setV((x) => ({ ...x, [key]: e.target.value }))}
            >
              <option value="">— не е избрана —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <ErrorText>{error}</ErrorText>
      {saved ? (
        <p role="status" className="mb-2 text-sm text-positive">
          Настройките са запазени.
        </p>
      ) : null}
      {canEdit ? (
        <Button inline type="submit" disabled={busy}>
          {busy ? 'Запис…' : 'Запази'}
        </Button>
      ) : (
        <p className="text-sm text-fg-muted">Настройките се променят от главния счетоводител.</p>
      )}
    </form>
  );
}

'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, ErrorText } from '@/components/ui';
import { setPeriodLock } from '../ledger-actions';

export function PeriodLockButton({
  periodId,
  locked,
  label,
}: {
  periodId: string;
  locked: boolean;
  label: string;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  async function run() {
    const r = await setPeriodLock(periodId, !locked);
    if (r.error !== undefined) setError(r.error);
    router.refresh();
  }
  return (
    <span>
      <ConfirmDialog
        trigger={
          <Button inline variant="secondary">
            {locked ? 'Отключи периода…' : 'Заключи периода…'}
          </Button>
        }
        title={locked ? `Отключване на ${label}` : `Заключване на ${label}`}
        description={
          locked
            ? 'Периодът отново ще приема статии и сторно. Отключването се записва в одитния журнал.'
            : 'След заключване никой не може да добавя, променя или сторнира статии в периода, включително импорти. Може да се отключи от главния счетоводител или собственика.'
        }
        confirmLabel={locked ? 'Отключи' : 'Заключи'}
        onConfirm={() => void run()}
      />
      <ErrorText>{error}</ErrorText>
    </span>
  );
}

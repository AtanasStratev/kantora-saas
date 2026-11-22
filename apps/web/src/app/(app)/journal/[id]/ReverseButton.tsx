'use client';
import { formatDate } from '@kantora/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, ErrorText, Kbd } from '@/components/ui';
import { reverseEntry } from '../../ledger-actions';

/** Reversal (F8): a new entry with opposite sides on the original's date. */
export function ReverseButton({
  entryId,
  number,
  defaultDate,
}: {
  entryId: string;
  number: number;
  defaultDate: string;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F8') {
        e.preventDefault();
        trigger.current?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div>
      <ConfirmDialog
        trigger={
          <Button ref={trigger} inline variant="danger">
            Сторнирай… <Kbd>F8</Kbd>
          </Button>
        }
        title={`Сторно на статия № ${number}`}
        description={`Ще се осчетоводи нова статия от ${formatDate(defaultDate)} със същите сметки и суми, но с обърнати страни. Оригиналът остава непроменен.`}
        confirmLabel="Сторнирай"
        onConfirm={async () => {
          const r = await reverseEntry(entryId, defaultDate);
          if (r.error !== undefined) {
            setError(r.error);
            return;
          }
          router.push(`/journal/${r.id}`);
          router.refresh();
        }}
      />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

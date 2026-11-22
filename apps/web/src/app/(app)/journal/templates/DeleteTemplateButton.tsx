'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button, ErrorText } from '@/components/ui';
import { deleteTemplate } from '../../ledger-actions';

export function DeleteTemplateButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  return (
    <span>
      <ConfirmDialog
        trigger={
          <Button inline variant="secondary">
            Изтрий…
          </Button>
        }
        title={`Изтриване на шаблона „${name}“`}
        description="Шаблонът изчезва от списъка с F4. Статиите, направени с него, не се променят."
        confirmLabel="Изтрий"
        onConfirm={() =>
          void deleteTemplate(id).then((r) => {
            if (r.error !== undefined) setError(r.error);
            router.refresh();
          })
        }
      />
      <ErrorText>{error}</ErrorText>
    </span>
  );
}

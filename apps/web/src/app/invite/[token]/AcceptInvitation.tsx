'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, ErrorText } from '@/components/ui';
import { acceptInvite } from './actions';

export function AcceptInvitation({
  token,
  signedInAs,
  invitedEmail,
}: {
  token: string;
  signedInAs: string;
  invitedEmail: string;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = signedInAs.toLowerCase() !== invitedEmail.toLowerCase();

  return (
    <div>
      <ErrorText>{error}</ErrorText>
      {mismatch ? (
        <p className="mb-3 text-sm text-warning">
          Влезли сте като {signedInAs}. Поканата е за {invitedEmail}: излезте и влезте с него.
        </p>
      ) : null}
      <Button
        autoFocus
        disabled={busy || mismatch}
        onClick={async () => {
          setBusy(true);
          const r = await acceptInvite(token);
          setBusy(false);
          if (r.error) {
            setError(r.error);
            return;
          }
          router.push('/');
          router.refresh();
        }}
      >
        {busy ? 'Приемане…' : 'Приеми поканата'}
      </Button>
    </div>
  );
}

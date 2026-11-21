'use client';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field } from '@/components/ui';
import { authClient, authErrorMessage } from '@/lib/auth-client';

type Enrollment = { qrDataUrl: string; secret: string; backupCodes: string[] };

export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const password = String(new FormData(e.currentTarget).get('password'));
    const { data, error } = await authClient.twoFactor.enable({ password });
    if (error || !data || !('totpURI' in data)) {
      setBusy(false);
      setError(authErrorMessage(error ?? {}));
      return;
    }
    // Rendered locally: the TOTP URI is a secret and never leaves the browser.
    const qrDataUrl = await QRCode.toDataURL(data.totpURI, { margin: 1, width: 192 });
    const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
    setEnrollment({ qrDataUrl, secret, backupCodes: data.backupCodes });
    setBusy(false);
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const code = String(new FormData(e.currentTarget).get('code')).replace(/\s/g, '');
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (error) {
      setError(authErrorMessage(error));
      return;
    }
    router.push('/');
    router.refresh();
  }

  if (!enrollment) {
    return (
      <form onSubmit={start} noValidate>
        <ErrorText>{error}</ErrorText>
        <Field
          label="Потвърдете паролата си"
          id="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
        />
        <Button type="submit" disabled={busy}>
          {busy ? 'Подготовка…' : 'Продължи'}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={confirm} noValidate>
      <ErrorText>{error}</ErrorText>
      <p className="mb-2 text-sm">1. Сканирайте кода с приложението:</p>
      <img
        src={enrollment.qrDataUrl}
        width={192}
        height={192}
        className="mx-auto mb-2 rounded bg-qr-surface p-2"
        alt="QR код за приложението за удостоверяване"
      />
      <p className="mb-4 text-center text-xs text-fg-muted">
        Или въведете ръчно: <code className="select-all break-all">{enrollment.secret}</code>
      </p>
      <p className="mb-1 text-sm">
        2. Запишете резервните кодове на сигурно място (всеки работи веднъж):
      </p>
      <pre className="mb-4 rounded border border-line bg-surface-sunken p-2 text-xs select-all">
        {enrollment.backupCodes.join('\n')}
      </pre>
      <Field
        label="3. Въведете 6-цифрения код от приложението"
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        autoFocus
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Проверка…' : 'Включи защитата'}
      </Button>
    </form>
  );
}

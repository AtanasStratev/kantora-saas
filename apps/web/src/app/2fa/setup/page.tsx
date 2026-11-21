import { redirect } from 'next/navigation';
import { Card } from '@/components/ui';
import { requireSession } from '@/lib/session';
import { SetupForm } from './SetupForm';

export default async function TwoFactorSetupPage() {
  const session = await requireSession({ allowWithout2fa: true });
  if (session.user.twoFactorEnabled) {
    redirect('/');
  }
  return (
    <Card title="Двуфакторна защита">
      <p className="mb-4 text-sm text-fg-muted">
        Задължителна е за всички потребители. Ще ви трябва приложение за удостоверяване на телефона
        (напр. Google Authenticator, Microsoft Authenticator или 2FAS).
      </p>
      <SetupForm />
    </Card>
  );
}

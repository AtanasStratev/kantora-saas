import Link from 'next/link';
import { Card } from '@/components/ui';
import { ResetPasswordForm } from './ResetPasswordForm';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  if (!token || error) {
    return (
      <Card title="Връзката не е валидна">
        <p className="mb-4 text-sm text-fg-muted">
          Връзката за смяна на паролата е изтекла или вече е използвана.
        </p>
        <Link href="/forgot-password" className="text-accent underline">
          Поискайте нова
        </Link>
      </Card>
    );
  }
  return (
    <Card title="Нова парола">
      <ResetPasswordForm token={token} />
    </Card>
  );
}

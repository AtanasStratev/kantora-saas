import { Card } from '@/components/ui';
import { safeNext } from '@/lib/safe-next';
import { TotpForm } from './TotpForm';

export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <Card title="Код за потвърждение">
      <p className="mb-4 text-sm text-fg-muted">
        Отворете приложението за удостоверяване на телефона си и въведете 6-цифрения код за
        „Кантора“.
      </p>
      <TotpForm next={safeNext(next)} />
    </Card>
  );
}

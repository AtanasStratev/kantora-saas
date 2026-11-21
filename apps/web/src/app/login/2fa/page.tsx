import { Card } from '@/components/ui';
import { TotpForm } from './TotpForm';

export default function TwoFactorPage() {
  return (
    <Card title="Код за потвърждение">
      <p className="mb-4 text-sm text-fg-muted">
        Отворете приложението за удостоверяване на телефона си и въведете 6-цифрения код за
        „Кантора“.
      </p>
      <TotpForm />
    </Card>
  );
}

import { Card } from '@/components/ui';
import { RegisterForm } from './RegisterForm';

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; email?: string }>;
}) {
  const { invite, email } = await searchParams;
  return (
    <Card title={invite ? 'Регистрация по покана' : 'Регистрация на кантора'}>
      <RegisterForm {...(invite ? { invite } : {})} {...(email ? { email } : {})} />
    </Card>
  );
}

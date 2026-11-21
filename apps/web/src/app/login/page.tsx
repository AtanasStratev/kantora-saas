import { Card } from '@/components/ui';
import { safeNext } from '@/lib/safe-next';
import { LoginForm } from './LoginForm';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <Card title="Вход">
      <LoginForm next={safeNext(next)} />
    </Card>
  );
}

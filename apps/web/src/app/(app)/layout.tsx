import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import { getAppContext } from '@/lib/context';
import { CreateOfficeForm } from '../CreateOfficeForm';
import { SignOutButton } from '../SignOutButton';
import { Shell } from './Shell';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAppContext();
  if (!ctx.office) {
    return (
      <Card title={`Здравейте, ${ctx.user.name}`}>
        <p className="mb-4 text-sm text-fg-muted">
          Още не сте член на кантора. Създайте своята, за да започнете.
        </p>
        <CreateOfficeForm />
        <SignOutButton />
      </Card>
    );
  }
  return <Shell ctx={ctx}>{children}</Shell>;
}

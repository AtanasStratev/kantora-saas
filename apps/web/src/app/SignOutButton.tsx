'use client';
import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="w-full rounded border border-line-strong px-3 py-1.5"
      onClick={async () => {
        await authClient.signOut();
        router.push('/login');
        router.refresh();
      }}
    >
      Изход
    </button>
  );
}

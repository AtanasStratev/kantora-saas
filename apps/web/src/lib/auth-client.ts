'use client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Browser-side calls go through /api/auth, so Better Auth's rate limiting applies
// (server-side auth.api calls are not rate limited).
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

/** Human Bulgarian messages for Better Auth error codes (design-system.md §1.5). */
export function authErrorMessage(error: {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
}): string {
  if (error.status === 429) {
    return 'Твърде много опити. Изчакайте минута и опитайте отново.';
  }
  switch (error.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'Грешен имейл или парола.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'Вече има регистрация с този имейл. Влезте или използвайте друг имейл.';
    case 'PASSWORD_TOO_SHORT':
      return 'Паролата трябва да е поне 12 символа.';
    case 'PASSWORD_TOO_LONG':
      return 'Паролата трябва да е най-много 128 символа.';
    case 'INVALID_EMAIL':
      return 'Имейлът не е валиден. Проверете за правописна грешка.';
    case 'INVALID_PASSWORD':
      return 'Паролата е грешна.';
    case 'INVALID_CODE':
    case 'INVALID_TWO_FACTOR_CODE':
    case 'INVALID_TOTP':
      return 'Кодът е грешен или е изтекъл. Въведете новия код от приложението.';
    case 'ACCOUNT_TEMPORARILY_LOCKED':
      return 'Профилът е временно заключен след много грешни кодове. Опитайте по-късно.';
    default:
      return 'Нещо се обърка. Опитайте отново; ако се повтаря, свържете се с поддръжката.';
  }
}

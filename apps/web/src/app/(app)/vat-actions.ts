'use server';
import { postVatDocument, saveVatSettings } from '@kantora/db';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';

type Result<T = object> = ({ error?: undefined } & T) | { error: string; problems?: string[] };

const id = z.union([z.uuid(), z.literal('')]).transform((v) => v || null);

/** Which accounts VAT documents post to (owner and chief accountant). */
export async function saveVatAccounts(input: {
  inputVatAccountId: string;
  outputVatAccountId: string;
  supplierAccountId: string;
  customerAccountId: string;
}): Promise<Result> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const p = z
    .object({
      inputVatAccountId: id,
      outputVatAccountId: id,
      supplierAccountId: id,
      customerAccountId: id,
    })
    .safeParse(input);
  if (!p.success) return { error: 'Невалидни данни.' };
  await saveVatSettings(appPool, scope.tenant, p.data);
  return {};
}

const Money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Сумата е с до 2 знака след запетаята.');
const DocInput = z.object({
  direction: z.enum(['purchase', 'sale']),
  kind: z.enum(['invoice', 'debit_note', 'credit_note']),
  number: z.string().trim().min(1, 'Въведете номер на документа.').max(50),
  issueDate: z.iso.date('Въведете дата на издаване.'),
  taxEventDate: z.iso.date('Въведете дата на данъчното събитие.'),
  counterpartyId: z.uuid('Изберете контрагент.'),
  relatedId: z.union([z.uuid(), z.literal('')]).transform((v) => v || null),
  lines: z
    .array(
      z.object({
        accountId: z.uuid('Изберете сметка.'),
        description: z.string().max(500),
        net: Money,
        rateKey: z.string().regex(/^vat_rate_[a-z0-9_]+$/, 'Изберете ставка.'),
        vat: Money,
      }),
    )
    .min(1, 'Документът няма редове.')
    .max(500),
});

/** Saves and posts a VAT document with its journal entry (ADR-0018). */
export async function saveVatDocument(
  input: z.input<typeof DocInput>,
): Promise<Result<{ documentId: string; entryNumber: number }>> {
  const scope = await companyScope('accounting.post');
  if ('error' in scope) return { error: scope.error };
  const p = DocInput.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.message ?? 'Невалидни данни.' };
  if (p.data.kind !== 'invoice' && !p.data.relatedId) {
    return { error: 'Изберете фактурата, която известието коригира.' };
  }
  const r = await postVatDocument(appPool, scope.tenant, p.data);
  return r.ok
    ? { documentId: r.documentId, entryNumber: r.entryNumber }
    : { error: 'Документът не е осчетоводен.', problems: r.problems };
}

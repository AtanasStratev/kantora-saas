'use server';
import { parseImportWorkbook } from '@kantora/domain';
import { applyImport, type ImportResult } from '@kantora/db';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { companyScope } from '@/lib/company-scope';
import { appPool } from '@/lib/db';
import { MAX_UPLOAD_BYTES, readXlsx, XlsxError } from '@/lib/import/xlsx-read';

export type ImportResponse =
  { error: string } | (ImportResult & { sha256: string; fileName: string; ignored: string[] });

/**
 * Checks (preview) or imports a template file (ADR-0017). The preview and the import run
 * the same code; the import is accepted only for the very file that was checked (same
 * SHA-256), so what was shown is what gets written. Owner and chief accountant only.
 */
export async function importFile(form: FormData): Promise<ImportResponse> {
  const scope = await companyScope('company.edit');
  if ('error' in scope) return { error: scope.error };
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { error: 'Изберете файл .xlsx.' };
  if (file.size > MAX_UPLOAD_BYTES) return { error: 'Файлът е по-голям от 10 MB.' };
  const opts = z
    .object({
      commit: z.enum(['0', '1']),
      expectedSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .or(z.literal('')),
      openingYear: z
        .string()
        .regex(/^\d{4}$/)
        .or(z.literal('')),
    })
    .safeParse({
      commit: form.get('commit'),
      expectedSha256: form.get('expectedSha256') ?? '',
      openingYear: form.get('openingYear') ?? '',
    });
  if (!opts.success) return { error: 'Невалидна заявка.' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const commit = opts.data.commit === '1';
  if (commit && sha256 !== opts.data.expectedSha256) {
    return { error: 'Файлът е различен от проверения. Проверете го отново.' };
  }
  let parsed;
  try {
    const wb = readXlsx(bytes);
    parsed = parseImportWorkbook(wb.sheets, { date1904: wb.date1904 });
  } catch (err) {
    if (err instanceof XlsxError) return { error: err.message };
    throw err;
  }
  const result = await applyImport(appPool, scope.tenant, parsed, {
    commit,
    fileName: file.name,
    sha256,
    openingYear: opts.data.openingYear ? Number(opts.data.openingYear) : null,
  });
  return { ...result, sha256, fileName: file.name, ignored: parsed.ignored };
}

'use client';
import { formatDate } from '@kantora/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button, ErrorText, Kbd, inputClass } from '@/components/ui';
import { importFile, type ImportResponse } from '../import-actions';

/**
 * 1) choose the file, 2) "Провери": preview with every problem by sheet and row,
 * 3) "Внеси" (only when the check passed, for the same file). Keyboard: Tab to the file
 * field, Space/Enter opens the file dialog, Ctrl+Enter checks or imports.
 */
function problemCount(res: ImportResponse | null): string {
  const n = res && !('error' in res) && !res.ok ? res.issues.length : 0;
  return n === 1 ? '1 проблем' : `${n} проблема`;
}

export function ImportForm({ years, defaultYear }: { years: number[]; defaultYear: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [year, setYear] = useState(String(defaultYear));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ImportResponse | null>(null);

  const checked = res && !('error' in res) && res.ok && !res.committed ? res : null;
  const done = res && !('error' in res) && res.ok && res.committed ? res : null;

  async function send(commit: boolean) {
    if (!file) {
      setRes({ error: 'Изберете файл .xlsx.' });
      input.current?.focus();
      return;
    }
    setBusy(true);
    const f = new FormData();
    f.set('file', file);
    f.set('commit', commit ? '1' : '0');
    f.set('expectedSha256', commit && checked ? checked.sha256 : '');
    f.set('openingYear', year);
    const r = await importFile(f);
    setBusy(false);
    setRes(r);
    if (!('error' in r) && r.ok && r.committed) router.refresh();
  }

  const s = res && !('error' in res) ? res.summary : null;
  return (
    <div
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'Enter') {
          e.preventDefault();
          void send(!!checked);
        }
      }}
    >
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Файл (.xlsx, до 10 MB)
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className={`${inputClass} w-96`}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setRes(null);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Начални салда за година
          <select
            className={inputClass}
            value={year}
            onChange={(e) => {
              setYear(e.target.value);
              setRes(null);
            }}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <Button
          inline
          variant={checked ? 'secondary' : 'primary'}
          disabled={busy}
          onClick={() => void send(false)}
        >
          {busy && !checked ? 'Проверка…' : 'Провери'}
          {checked ? null : (
            <>
              {' '}
              <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
            </>
          )}
        </Button>
        {checked ? (
          <Button inline disabled={busy} onClick={() => void send(true)}>
            {busy ? 'Внасяне…' : 'Внеси'} <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
          </Button>
        ) : null}
      </div>

      {res && 'error' in res ? <ErrorText>{res.error}</ErrorText> : null}

      {s ? (
        <section aria-label="Резултат от проверката" className="mb-4">
          <p
            role="status"
            className={`mb-2 text-sm ${done ? 'text-positive' : checked ? 'text-positive' : 'text-negative'}`}
          >
            {done
              ? 'Файлът е внесен.'
              : checked
                ? 'Проверката мина. Нищо не е записано; натиснете „Внеси“.'
                : `Файлът не е внесен: ${problemCount(res)}. Поправете ги и проверете отново.`}
          </p>
          <table className="mb-3 text-sm" aria-label="Какво съдържа файлът">
            <tbody>
              <tr>
                <th className="pr-4 text-left font-normal text-fg-muted">Сметки</th>
                <td data-testid="imp-accounts">
                  {s.accounts.added} нови, {s.accounts.existing} вече има
                </td>
              </tr>
              <tr>
                <th className="pr-4 text-left font-normal text-fg-muted">Контрагенти</th>
                <td>
                  {s.counterparties.added} нови, {s.counterparties.existing} вече има
                </td>
              </tr>
              <tr>
                <th className="pr-4 text-left font-normal text-fg-muted">Обекти</th>
                <td>
                  {s.objects.added} нови, {s.objects.existing} вече има
                </td>
              </tr>
              <tr>
                <th className="pr-4 text-left font-normal text-fg-muted">Начални салда</th>
                <td data-testid="imp-opening">
                  {s.opening.lines ? `${s.opening.lines} реда към 01.01.${s.opening.year}` : '—'}
                </td>
              </tr>
              <tr>
                <th className="pr-4 text-left font-normal text-fg-muted">Статии</th>
                <td data-testid="imp-entries">
                  {s.entries.posted}
                  {s.entries.first && s.entries.last
                    ? ` (${formatDate(s.entries.first)} – ${formatDate(s.entries.last)})`
                    : ''}
                </td>
              </tr>
            </tbody>
          </table>
          {res && !('error' in res) && res.ignored.length ? (
            <p className="mb-2 text-xs text-fg-muted">
              Пропуснати листове: {res.ignored.join(', ')}.
            </p>
          ) : null}
          {res && !('error' in res) && !res.ok ? (
            <table className="w-full border-collapse text-sm" aria-label="Проблеми във файла">
              <thead>
                <tr className="border-b border-line-strong text-left text-xs text-fg-muted">
                  <th className="w-36 px-2 py-1 font-normal">Лист</th>
                  <th className="w-16 px-2 py-1 text-right font-normal">Ред</th>
                  <th className="px-2 py-1 font-normal">Проблем</th>
                </tr>
              </thead>
              <tbody>
                {res.issues.map((i, k) => (
                  <tr key={k} className="border-b border-line">
                    <td className="px-2 py-1">{i.sheet}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{i.row || ''}</td>
                    <td className="px-2 py-1 text-negative">{i.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {done ? (
            <p className="text-sm">
              <Link className="text-accent underline" href="/journal">
                Към статиите
              </Link>{' '}
              ·{' '}
              <Link className="text-accent underline" href="/reports/trial-balance">
                Към оборотната ведомост
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

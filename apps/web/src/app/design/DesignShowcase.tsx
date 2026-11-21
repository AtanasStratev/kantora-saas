'use client';
import { formatAmount, formatDate } from '@kantora/domain';
import { useMemo, useState, type ReactNode } from 'react';
import { AmountInput } from '@/components/AmountInput';
import { Checkbox } from '@/components/Checkbox';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { DateInput } from '@/components/DateInput';
import { Select } from '@/components/Select';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { Badge, Button, EmptyState, ErrorText, Field, Kbd, ValidationList } from '@/components/ui';

type DemoRow = {
  n: number;
  date: string;
  doc: string;
  party: string;
  debit: string;
  credit: string;
};

const PARTIES = ['Алфа ЕООД', 'Бета ООД', 'Гама АД', 'Делта ЕТ', 'Епсилон ЕООД', 'Зета ООД'];

/** 100 000 deterministic demo rows (no randomness, so screenshots are stable). */
function demoRows(count: number): DemoRow[] {
  const rows: DemoRow[] = [];
  for (let i = 0; i < count; i++) {
    const day = (i % 28) + 1;
    const cents = ((i * 7919) % 1_000_000) + 100;
    const amount = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    rows.push({
      n: i + 1,
      date: `2026-11-${String(day).padStart(2, '0')}`,
      doc: `Ф-${String(100000 + i)}`,
      party: PARTIES[i % PARTIES.length] ?? '',
      debit: i % 2 ? amount : '0.00',
      credit: i % 2 ? '0.00' : amount,
    });
  }
  return rows;
}

const COLUMNS: Column<DemoRow>[] = [
  { key: 'n', header: '№', width: 70, align: 'right', cell: (r) => r.n.toLocaleString('bg-BG') },
  { key: 'date', header: 'Дата', width: 100, cell: (r) => formatDate(r.date) },
  { key: 'doc', header: 'Документ', width: 110, cell: (r) => r.doc },
  { key: 'party', header: 'Контрагент', width: 170, cell: (r) => r.party },
  { key: 'd', header: 'Дебит', width: 120, align: 'right', cell: (r) => formatAmount(r.debit) },
  { key: 'c', header: 'Кредит', width: 120, align: 'right', cell: (r) => formatAmount(r.credit) },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 rounded border border-line bg-surface-raised p-5">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function DesignShowcase() {
  const rows = useMemo(() => demoRows(100_000), []);
  const [opened, setOpened] = useState('');
  const [deleted, setDeleted] = useState(false);
  const period = { year: 2026, month: 11, today: '2026-11-21' };

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Дизайн система</h1>
          <p className="text-sm text-fg-muted">
            Всички компоненти в текущата тема. Смяна на темата: <Kbd>Alt</Kbd>+<Kbd>T</Kbd>
          </p>
        </div>
        <ThemeSwitcher />
      </header>

      <Section title="Цветове (семантични токени)">
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {[
            ['surface', 'bg-surface'],
            ['surface-raised', 'bg-surface-raised'],
            ['surface-sunken', 'bg-surface-sunken'],
            ['surface-selected', 'bg-surface-selected'],
          ].map(([name, cls]) => (
            <div key={name} className={`rounded border border-line p-3 ${cls}`}>
              --{name}
            </div>
          ))}
        </div>
        <p className="mt-3 flex flex-wrap gap-4 text-sm">
          <span>Текст</span>
          <span className="text-fg-muted">Помощен текст</span>
          <span className="text-accent">Връзка</span>
          <span className="text-positive">Успех</span>
          <span className="text-negative">Грешка / отрицателно</span>
          <span className="text-warning">Предупреждение</span>
        </p>
      </Section>

      <Section title="Бутони и значки">
        <div className="mb-4 flex flex-wrap gap-2">
          <Button inline>Запис</Button>
          <Button inline variant="secondary">
            Отказ
          </Button>
          <Button inline variant="danger">
            Сторно
          </Button>
          <Button inline variant="ghost">
            Още
          </Button>
          <Button inline disabled>
            Неактивен
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge kind="draft" />
          <Badge kind="posted" />
          <Badge kind="reversed" />
          <Badge kind="locked" />
          <Badge kind="warning" />
        </div>
      </Section>

      <Section title="Полета за въвеждане">
        <div className="grid gap-x-6 sm:grid-cols-2">
          <Field label="Наименование" id="demo-name" placeholder="Алфа ЕООД" />
          <Field
            label="ЕИК"
            id="demo-eik"
            defaultValue="123"
            error="ЕИК трябва да е 9 или 13 цифри."
          />
          <AmountInput label="Сума (опитайте 1234,5 или 1.234,567)" />
          <AmountInput label="Количество (до 4 знака)" maxDecimals={4} />
          <DateInput label="Дата на документа" period={period} />
          <Select
            label="ДДС ставка (примерни етикети)"
            options={[
              { value: 'a', label: 'Основна' },
              { value: 'b', label: 'Намалена' },
              { value: 'c', label: 'Освободена доставка' },
            ]}
          />
          <Checkbox label="Начисли ДДС" defaultChecked />
        </div>
        <ErrorText>Примерно съобщение за грешка във формата.</ErrorText>
      </Section>

      <Section title="Потвърждение на опасни действия">
        <div className="flex flex-wrap items-center gap-3">
          <ConfirmDialog
            trigger={
              <Button inline variant="danger">
                Изтрий черновата…
              </Button>
            }
            title="Изтриване на чернова"
            description="Черновата на документ Ф-100001 ще бъде изтрита. Осчетоводени документи не се трият; те се сторнират."
            confirmLabel="Изтрий"
            typeToConfirm="изтрий"
            onConfirm={() => setDeleted(true)}
          />
          {deleted ? (
            <span className="text-sm text-fg-muted">Черновата е изтрита (демо).</span>
          ) : null}
        </div>
      </Section>

      <Section title="Празно състояние и списък с грешки">
        <div className="mb-4">
          <EmptyState
            title="Още няма документи за ноември 2026"
            next="Въведете първия документ с"
            shortcut="F2"
          />
        </div>
        <ValidationList
          issues={[
            {
              message: 'Фактура Ф-100002 от 05.11.2026: липсва ДДС номер на контрагента.',
              fix: 'Добавете ДДС номера в картона на контрагента или отбележете, че не е регистриран.',
              href: '#',
            },
            {
              message: 'Статия 118: дебитът (120,00) не е равен на кредита (100,00).',
              fix: 'Добавете ред за разликата от 20,00 или поправете сумите.',
            },
          ]}
        />
      </Section>

      <Section title="Таблица: 100 000 реда">
        <p className="mb-2 text-sm text-fg-muted">
          Кликнете в таблицата и използвайте <Kbd>↑</Kbd> <Kbd>↓</Kbd> <Kbd>PgUp</Kbd>{' '}
          <Kbd>PgDn</Kbd> <Kbd>Home</Kbd> <Kbd>End</Kbd>; <Kbd>Enter</Kbd> отваря реда.
        </p>
        <DataTable
          rows={rows}
          columns={COLUMNS}
          label="demo-journal"
          onOpen={(r) => setOpened(`${r.doc} · ${r.party}`)}
        />
        {opened ? <p className="mt-2 text-sm">Отворен: {opened}</p> : null}
      </Section>
    </main>
  );
}

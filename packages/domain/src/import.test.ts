import { describe, expect, it } from 'vitest';
import { parseImportWorkbook, type ImportCell, type ImportSheet } from './import';
import { excelNumberToMoney } from './rounding';

// Account codes, names and amounts are illustrative test data.
const t = (value: string): ImportCell => ({ type: 'text', value });
const n = (value: string): ImportCell => ({ type: 'number', value });
const sheet = (name: string, rows: (ImportCell | undefined)[][]): ImportSheet => ({ name, rows });
const H = (...names: string[]) => names.map(t);

describe('excelNumberToMoney', () => {
  it('reads the binary float Excel stores as the 2-decimal amount it shows', () => {
    expect(excelNumberToMoney('1234.5599999999999')).toBe('1234.56');
    expect(excelNumberToMoney('0.30000000000000004')).toBe('0.30');
    expect(excelNumberToMoney('100')).toBe('100.00');
    expect(excelNumberToMoney('1.2E3')).toBe('1200.00');
  });
  it('refuses real third decimals instead of rounding them away', () => {
    expect(excelNumberToMoney('10.005')).toBeNull();
    expect(excelNumberToMoney('abc')).toBeNull();
  });
});

describe('parseImportWorkbook', () => {
  it('reads accounts, counterparties and objects; columns are found by their names', () => {
    const p = parseImportWorkbook([
      sheet('Сметки', [
        H('Наименование', 'Код', 'Контрагент', 'Документ', 'Валутна', 'Превалутиране'),
        [t('Доставчици'), t('401'), t('да'), t('x'), undefined, undefined],
        [t('Основен капитал'), n('101'), undefined, undefined, undefined, t('капитал')],
      ]),
      sheet('Контрагенти', [
        H('Наименование', 'ЕИК', 'ДДС номер'),
        [t('Алфа'), t(''), t('bg 123')],
      ]),
      sheet('Обекти', [H('Код', 'Наименование'), [t('О1'), t('Обект 1')]]),
      sheet('Бележки', [[t('свободен текст')]]),
    ]);
    expect(p.issues).toEqual([]);
    expect(
      p.accounts.map((a) => [a.code, a.needs.counterparty, a.needs.document, a.conversion]),
    ).toEqual([
      ['401', true, true, 'standard'],
      ['101', false, false, 'equity'],
    ]);
    expect(p.counterparties[0]).toMatchObject({
      name: 'Алфа',
      eik: null,
      vatNumber: 'BG123',
      country: 'BG',
    });
    expect(p.objects).toEqual([{ row: 2, code: 'О1', name: 'Обект 1' }]);
    expect(p.ignored).toEqual(['Бележки']);
  });

  it('groups journal lines by entry number; reads Excel dates and Bulgarian amounts', () => {
    const p = parseImportWorkbook([
      sheet('Статии', [
        H('Статия', 'Дата', 'Основание', 'Сметка', 'Дебит', 'Кредит', 'Контрагент', 'Документ №'),
        // 46019 = 2025-12-28 in the 1900 date system (45658 = 2025-01-01)
        [t('1'), n('46019'), t('Доставка'), t('601'), t('1 234,56'), undefined],
        [
          t('1'),
          n('46019'),
          t('Доставка'),
          t('401'),
          undefined,
          n('1234.5599999999999'),
          t('Алфа'),
          t('Ф-1'),
        ],
        [t('2'), t('05.01.2026'), t('Плащане'), t('401'), n('100'), undefined, t('Алфа'), t('Ф-1')],
        [t('2'), t('05.01.2026'), t('Плащане'), t('503'), undefined, t('100,00')],
      ]),
    ]);
    expect(p.issues).toEqual([]);
    expect(
      p.entries.map((e) => [e.key, e.date, e.lines.map((l) => [l.account, l.side, l.amount])]),
    ).toEqual([
      [
        '1',
        '2025-12-28',
        [
          ['601', 'D', '1234.56'],
          ['401', 'C', '1234.56'],
        ],
      ],
      [
        '2',
        '2026-01-05',
        [
          ['401', 'D', '100.00'],
          ['503', 'C', '100.00'],
        ],
      ],
    ]);
    expect(p.entries[0]?.lines[1]).toMatchObject({
      counterparty: 'Алфа',
      documentNumber: 'Ф-1',
      row: 3,
    });
  });

  it('lists every problem with its sheet and row, and does not stop at the first', () => {
    const p = parseImportWorkbook([
      sheet('Статии', [
        H('Статия', 'Дата', 'Сметка', 'Дебит', 'Кредит'),
        [t('1'), t('31.02.2026'), t('601'), t('10'), undefined],
        [t('2'), t('01.03.2026'), t('601'), t('10'), t('10')],
        [t('3'), t('01.03.2026'), t('601'), n('10.005'), undefined],
        [t('4'), t('01.03.2026'), t('601'), t('10'), undefined],
        [t('4'), t('01.03.2026'), t('401'), undefined, t('9')],
        [undefined, t('01.03.2026'), t('401'), undefined, t('9')],
      ]),
      sheet('Сметки', [H('Код', 'Наименование'), [t('1 01'), t('Х')]]),
      sheet('Обекти', [H('Наименование')]),
    ]);
    const msgs = p.issues.map((i) => `${i.sheet}:${i.row}:${i.message}`);
    expect(msgs).toEqual([
      'Статии:2:Дата: неразпозната дата „31.02.2026“ (пример: 15.11.2026).',
      'Статии:3:Попълнете или дебит, или кредит.',
      'Статии:4:Дебит: сумата 10.005 има повече от 2 знака след запетаята.',
      'Статии:7:Липсва номер на статия (редовете на една статия имат еднакъв номер).',
      'Сметки:2:Невалиден код на сметка „1 01“.',
      'Обекти:1:Липсват колони: Код.',
      expect.stringMatching(/^Статии:5:Статия 4: Дебитът \(10,00\) не е равен на кредита \(9,00\)/),
    ]);
  });

  it('opening balances must balance; duplicates are reported', () => {
    const p = parseImportWorkbook([
      sheet('Начални салда', [
        H('Сметка', 'Дебит', 'Кредит'),
        [t('503'), t('100'), undefined],
        [t('101'), undefined, t('90')],
      ]),
      sheet('Сметки', [H('Код', 'Наименование'), [t('503'), t('Банка')], [t('503'), t('Банка 2')]]),
    ]);
    expect(p.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/^Началните салда не се равняват/),
      'Сметка „503“ се повтаря (първо на ред 2).',
    ]);
  });
});

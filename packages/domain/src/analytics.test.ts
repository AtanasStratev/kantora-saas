import { describe, expect, it } from 'vitest';
import { analyticBalance, analyticsProblems, parseEik, parseVatNumber } from './analytics';

// Account codes are illustrative test data, not a prescribed chart of accounts.
const all = { counterparty: true, document: true, costObject: true };
const none = { counterparty: false, document: false, costObject: false };

describe('analyticsProblems', () => {
  it('names the line, the account and what is missing', () => {
    const p = analyticsProblems([
      { accountCode: '601', needs: none },
      { accountCode: '401', needs: all },
    ]);
    expect(p.map((x) => x.message)).toEqual([
      'Ред 2: сметка 401 изисква контрагент.',
      'Ред 2: сметка 401 изисква номер на документ.',
      'Ред 2: сметка 401 изисква обект.',
    ]);
  });

  it('accepts a complete line; a blank document number does not count', () => {
    expect(
      analyticsProblems([
        {
          accountCode: '401',
          needs: all,
          counterpartyId: 'c',
          documentNumber: 'Ф-1',
          costObjectId: 'o',
        },
      ]),
    ).toEqual([]);
    expect(
      analyticsProblems([
        { accountCode: '401', needs: { ...none, document: true }, documentNumber: '  ' },
      ]),
    ).toHaveLength(1);
  });

  it('a document date needs a number, even on an account without needs', () => {
    expect(
      analyticsProblems([{ accountCode: '501', needs: none, documentDate: '2026-03-01' }]).map(
        (x) => x.code,
      ),
    ).toEqual(['DOCUMENT_DATE_WITHOUT_NUMBER']);
  });
});

describe('parseEik / parseVatNumber', () => {
  it('EIK: spaces removed, empty is none, 9 or 13 digits only', () => {
    expect(parseEik(' 123 456 789 ')).toEqual({ ok: true, value: '123456789' });
    expect(parseEik('')).toEqual({ ok: true, value: null });
    expect(parseEik('1234567890123')).toEqual({ ok: true, value: '1234567890123' });
    expect(parseEik('12345678').ok).toBe(false);
    expect(parseEik('1234567890').ok).toBe(false);
    expect(parseEik('12345678A').ok).toBe(false);
  });

  it('VAT number: upper case, country prefix', () => {
    expect(parseVatNumber('bg 123456789')).toEqual({ ok: true, value: 'BG123456789' });
    expect(parseVatNumber('')).toEqual({ ok: true, value: null });
    expect(parseVatNumber('123456789').ok).toBe(false);
  });
});

describe('analyticBalance', () => {
  const L = (key: string, date: string, side: 'D' | 'C', amount: string) => ({
    key,
    date,
    side,
    amount,
  });

  it('opening before the range, turnover inside, signed closing; nothing after `to`', () => {
    const rows = analyticBalance(
      [
        L('a', '2026-01-05', 'C', '100.00'),
        L('a', '2026-02-03', 'D', '40.00'),
        L('a', '2026-02-20', 'C', '10.10'),
        L('a', '2026-03-01', 'D', '999.00'),
        L('b', '2026-02-10', 'D', '5.00'),
      ],
      '2026-02-01',
      '2026-02-28',
    );
    expect(rows).toEqual([
      { key: 'a', opening: '-100.00', debit: '40.00', credit: '10.10', closing: '-70.10' },
      { key: 'b', opening: '0.00', debit: '5.00', credit: '0.00', closing: '5.00' },
    ]);
  });

  it('leaves out keys with nothing in or before the range', () => {
    expect(
      analyticBalance([L('z', '2026-05-01', 'D', '1.00')], '2026-02-01', '2026-02-28'),
    ).toEqual([]);
  });
});

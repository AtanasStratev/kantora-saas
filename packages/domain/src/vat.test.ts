import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  lineVat,
  vatDocumentProblems,
  vatPostingLines,
  vatTotals,
  type VatLine,
  type VatSettings,
} from './vat';

// Rates and accounts are FICTITIOUS test data (10 % and 7 % are not Bulgarian rates):
// real rates come only from legal_parameter with their official source.
const settings: VatSettings = {
  inputVatAccountId: 'in-vat',
  outputVatAccountId: 'out-vat',
  supplierAccountId: 'suppliers',
  customerAccountId: 'customers',
};
const line = (net: string, rate: string, vat = lineVat(net, rate)): VatLine => ({
  accountId: `acc-${rate}`,
  accountCode: 'x',
  description: '',
  net,
  rateKey: `test_${rate}`,
  ratePercent: rate,
  vat,
});
const balance = (ls: ReturnType<typeof vatPostingLines>) =>
  ls
    .reduce((s, l) => (l.side === 'D' ? s.plus(l.amount) : s.minus(l.amount)), new Decimal(0))
    .toFixed(2);

describe('VAT of a line and totals', () => {
  it('net × rate %, to the cent', () => {
    expect(lineVat('100.00', '10')).toBe('10.00');
    expect(lineVat('0.05', '10')).toBe('0.01'); // 0.005 → 0.01
    expect(lineVat('19.99', '7')).toBe('1.40'); // 1.3993
    expect(vatTotals([line('100.00', '10'), line('19.99', '7')])).toEqual({
      net: '119.99',
      vat: '11.40',
      gross: '131.39',
    });
  });
});

describe('vatDocumentProblems', () => {
  it('a sale must have the computed VAT; a purchase may differ by one cent per line', () => {
    expect(
      vatDocumentProblems('sale', [line('19.99', '7', '1.39')], settings).map((p) => p.code),
    ).toEqual(['VAT_MISMATCH']);
    expect(vatDocumentProblems('purchase', [line('19.99', '7', '1.39')], settings)).toEqual([]);
    expect(
      vatDocumentProblems('purchase', [line('19.99', '7', '1.37')], settings).map((p) => p.code),
    ).toEqual(['VAT_MISMATCH']);
  });
  it('needs lines, a positive base and the accounts of the settings', () => {
    expect(
      vatDocumentProblems('purchase', [line('0', '10')], {
        ...settings,
        inputVatAccountId: null,
      }).map((p) => p.message),
    ).toEqual([
      'Ред 1: данъчната основа трябва да е положителна.',
      'В настройките на ДДС липсва сметка за ДДС за покупките.',
    ]);
    expect(vatDocumentProblems('sale', [], settings).map((p) => p.code)).toEqual(['NO_LINES']);
  });
});

describe('vatPostingLines', () => {
  it('purchase invoice: Дт the line accounts and input VAT, Кт the supplier (total)', () => {
    const ls = vatPostingLines(
      'purchase',
      'invoice',
      [line('100.00', '10'), line('50.00', '7')],
      settings,
    );
    expect(ls.map((l) => [l.accountId, l.side, l.amount, l.withDocument])).toEqual([
      ['acc-10', 'D', '100.00', false],
      ['acc-7', 'D', '50.00', false],
      ['in-vat', 'D', '13.50', true],
      ['suppliers', 'C', '163.50', true],
    ]);
    expect(balance(ls)).toBe('0.00');
  });
  it('sale invoice: Дт the customer, Кт the revenue and output VAT; a credit note swaps sides', () => {
    const inv = vatPostingLines('sale', 'invoice', [line('200.00', '10')], settings);
    expect(inv.map((l) => [l.accountId, l.side, l.amount])).toEqual([
      ['customers', 'D', '220.00'],
      ['acc-10', 'C', '200.00'],
      ['out-vat', 'C', '20.00'],
    ]);
    const cn = vatPostingLines('sale', 'credit_note', [line('200.00', '10')], settings);
    expect(cn.map((l) => l.side)).toEqual(['C', 'D', 'D']);
    expect(balance(cn)).toBe('0.00');
  });
  it('a zero-rate line posts no VAT line', () => {
    const ls = vatPostingLines('purchase', 'invoice', [line('80.00', '0')], settings);
    expect(ls.map((l) => l.accountId)).toEqual(['acc-0', 'suppliers']);
  });
});

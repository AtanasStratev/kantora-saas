import { describe, expect, it } from 'vitest';
import {
  MissingLegalParameterError,
  numericAt,
  parameterAt,
  type LegalParameter,
} from './legal-parameters';

// Fictional parameter used only to exercise date logic — not a real legal value.
const p = (validFrom: string, validTo: string | null, value: string): LegalParameter => ({
  key: 'test_threshold',
  valueNumeric: value,
  valueJson: null,
  validFrom,
  validTo,
  sourceUrl: 'https://example.test/source',
  sourceRef: 'тестов източник',
});

const HISTORY = [p('2024-01-01', '2025-12-31', '100'), p('2026-01-01', null, '200')];

describe('parameterAt', () => {
  it('picks the version valid on the date, with inclusive boundaries', () => {
    expect(numericAt(HISTORY, 'test_threshold', '2024-01-01')).toBe('100');
    expect(numericAt(HISTORY, 'test_threshold', '2025-12-31')).toBe('100');
    expect(numericAt(HISTORY, 'test_threshold', '2026-01-01')).toBe('200');
    expect(numericAt(HISTORY, 'test_threshold', '2099-06-30')).toBe('200');
  });

  it('refuses to guess before the first known version', () => {
    expect(() => parameterAt(HISTORY, 'test_threshold', '2023-12-31')).toThrow(
      MissingLegalParameterError,
    );
  });

  it('refuses an unknown key with a message that says how to fix it', () => {
    expect(() => parameterAt(HISTORY, 'nope', '2026-01-01')).toThrow(
      /Добавете я с официален източник/,
    );
  });

  it('rejects overlapping versions', () => {
    const bad = [...HISTORY, p('2025-06-01', null, '150')];
    expect(() => parameterAt(bad, 'test_threshold', '2025-07-01')).toThrow(/Припокриващи/);
  });

  it('handles a gap between versions as missing, not as the previous value', () => {
    const gap = [p('2024-01-01', '2024-12-31', '1'), p('2025-02-01', null, '2')];
    expect(() => parameterAt(gap, 'test_threshold', '2025-01-15')).toThrow(
      MissingLegalParameterError,
    );
  });
});

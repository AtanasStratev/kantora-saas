/**
 * Legal parameters with validity dates (PROMPT.md 3.1): rates, thresholds, coefficients.
 * Business logic asks "what was X on date D?" and never hard-codes the answer.
 * Every value carries its official source; values without a source are not accepted.
 */
export type IsoDateString = string; // YYYY-MM-DD

export type LegalParameter = {
  key: string;
  valueNumeric: string | null; // decimal string, never float
  valueJson: unknown;
  validFrom: IsoDateString;
  validTo: IsoDateString | null; // inclusive; null = open-ended
  sourceUrl: string;
  sourceRef: string;
};

export class MissingLegalParameterError extends Error {
  constructor(
    public readonly key: string,
    public readonly date: IsoDateString,
  ) {
    super(`Няма въведена стойност за „${key}“ към ${date}. Добавете я с официален източник.`);
  }
}

function covers(p: LegalParameter, date: IsoDateString): boolean {
  return p.validFrom <= date && (p.validTo === null || date <= p.validTo);
}

/**
 * The single version of `key` valid on `date`. Throws when there is none (the caller must
 * not guess a value) or when versions overlap (a data error the database also prevents).
 */
export function parameterAt(
  params: readonly LegalParameter[],
  key: string,
  date: IsoDateString,
): LegalParameter {
  const hits = params.filter((p) => p.key === key && covers(p, date));
  if (hits.length === 0) throw new MissingLegalParameterError(key, date);
  if (hits.length > 1) {
    throw new Error(`Припокриващи се версии на „${key}“ към ${date}.`);
  }
  return hits[0] as LegalParameter;
}

/** Numeric value (decimal string) of `key` on `date`. */
export function numericAt(
  params: readonly LegalParameter[],
  key: string,
  date: IsoDateString,
): string {
  const p = parameterAt(params, key, date);
  if (p.valueNumeric === null) throw new Error(`„${key}“ не е числов параметър.`);
  return p.valueNumeric;
}

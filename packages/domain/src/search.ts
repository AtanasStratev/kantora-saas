/**
 * Search normalization for the command palette and autocompletion: accountants type
 * company names in Cyrillic or in Latin ("petrov" must find "Петров ЕООД").
 * The mapping follows the Bulgarian streamlined romanization (щ→sht, ъ→a, ...). It is
 * used ONLY for matching, never for display or official data, so it is not a legal
 * transliteration and needs no legal source.
 */

const MULTI: [string, string][] = [
  ['щ', 'sht'],
  ['ж', 'zh'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['ю', 'yu'],
  ['я', 'ya'],
];

const SINGLE: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ъ: 'a',
  ь: 'y',
};

/** Cyrillic → Latin, lower-case. Latin input passes through unchanged. */
export function toLatin(text: string): string {
  let s = text.toLowerCase();
  for (const [cyr, lat] of MULTI) s = s.split(cyr).join(lat);
  return [...s].map((ch) => SINGLE[ch] ?? ch).join('');
}

/** Lower-case, Latin, letters and digits only: the form both sides are compared in. */
export function searchKey(text: string): string {
  return toLatin(text).replace(/[^a-z0-9]+/g, '');
}

/**
 * Score of `query` against `text`: 0 = no match. Prefix of the whole text scores
 * highest, then prefix of a word, then a contiguous substring, then all characters in
 * order (subsequence), so "pt eood" still finds "Петров ЕООД".
 */
export function matchScore(text: string, query: string): number {
  const q = searchKey(query);
  if (q === '') return 1;
  const t = searchKey(text);
  if (t.startsWith(q)) return 100;
  const words = toLatin(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 80;
  if (t.includes(q)) return 60;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 20 : 0;
}

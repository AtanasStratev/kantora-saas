import { describe, expect, it } from 'vitest';
import { matchScore, searchKey, toLatin } from './search';

describe('toLatin (streamlined Bulgarian transliteration, matching only)', () => {
  it.each([
    ['Петров', 'petrov'],
    ['Щастие', 'shtastie'],
    ['Жълт', 'zhalt'],
    ['Цветя', 'tsvetya'],
    ['Юлия', 'yuliya'],
    ['Чайка Шипка', 'chayka shipka'],
    ['ABC ООД', 'abc ood'],
  ])('%s → %s', (input, expected) => {
    expect(toLatin(input)).toBe(expected);
  });
});

describe('searchKey', () => {
  it('drops punctuation and spaces', () => {
    expect(searchKey('„Петров“ ЕООД, гр. София')).toBe('petroveoodgrsofiya');
  });
});

describe('matchScore', () => {
  it('finds Cyrillic names typed in Latin and vice versa', () => {
    expect(matchScore('Петров ЕООД', 'petrov')).toBeGreaterThan(0);
    expect(matchScore('Petrov Ltd', 'петров')).toBeGreaterThan(0);
  });

  it('ranks whole-prefix > word-prefix > substring > subsequence', () => {
    const name = 'Алфа Строй ЕООД';
    const prefix = matchScore(name, 'алф');
    const word = matchScore(name, 'строй');
    const sub = matchScore(name, 'трой');
    const seq = matchScore(name, 'асе');
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(seq);
    expect(seq).toBeGreaterThan(0);
  });

  it('returns 0 when there is no match', () => {
    expect(matchScore('Бета ООД', 'гама')).toBe(0);
  });

  it('matches EIK digits', () => {
    expect(matchScore('Гама АД 123456789', '1234')).toBeGreaterThan(0);
  });

  it('empty query matches everything', () => {
    expect(matchScore('Каквото и да е', '')).toBe(1);
  });
});

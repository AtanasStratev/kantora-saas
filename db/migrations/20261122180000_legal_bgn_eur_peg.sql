-- migrate:up

-- Rate of the lev to the euro for transactions in euro while the books were kept in leva
-- (ЗСч чл. 5, ал. 1 in its wording until 31.12.2025: the lev equivalent by the BNB central
-- rate). Under the currency board the BNB did not publish a daily euro rate (the euro is
-- absent from its daily list, sample docs/legal/fx/bnb-sample-2025-12-30-bgn.xml); the BNB
-- publishes the fixed rate 1.95583 instead. Verified 2026-11-22 on bnb.bg:
--   * https://bnb.bg/AboutUs/AUHistory/AUHBNBHistory/ : „от 1999 г. – към еврото по курс
--     1.95583 лева за 1 евро“; the lev was denominated the same year.
--   * https://www.bnb.bg/statistics/stexternalsector/stexchangerates/sterfixed/index.htm :
--     „Български лев | BGN | 1.95583“.
-- valid_from 2000-01-01 on purpose: in 1999 the denomination (1000 old leva = 1 lev) took
-- place on a date not yet verified here, so 1999 is left out rather than guessed.
DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-parameters', true);
  INSERT INTO app.legal_parameter (key, value_numeric, valid_from, valid_to, source_url, source_ref, verified_at)
  VALUES (
    'bgn_per_eur_currency_board',
    1.95583,
    DATE '2000-01-01',
    DATE '2025-12-31',
    'https://bnb.bg/AboutUs/AUHistory/AUHBNBHistory/',
    'БНБ: история (паричен съвет; от 1999 г. левът е фиксиран към еврото по курс 1.95583) и страница „Фиксирани валутни курсове“; ЗСч чл. 5, ал. 1 (редакция до 31.12.2025)',
    DATE '2026-11-22'
  );
END
$$;

-- migrate:down

DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-parameters', true);
  DELETE FROM app.legal_parameter WHERE key = 'bgn_per_eur_currency_board';
END
$$;

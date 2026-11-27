-- migrate:up

-- VAT rates (ADR-0018), from the text of ЗДДС kept in docs/legal/vat/ZDDS-lex-bg-2026-11-27.txt
-- (lex.bg, consolidated to ДВ бр. 69 of 31.07.2026; verified 2026-11-27).
--   чл. 66, ал. 1 (изм. ДВ бр. 52/2022, в сила от 01.07.2022): "Стандартната ставка на
--     данъка е 20 на сто"
--   чл. 66а (изм. ДВ бр. 102/2022, в сила от 01.01.2023): "Ставката на данъка е 9 на сто"
--     only for the supplies listed there (accommodation, books and periodicals, baby
--     food and hygiene articles)
--   чл. 66б (нов ДВ бр. 52/2022, в сила от 01.07.2022): the zero rate for the supplies in
--     chapter three, чл. 53, 64а, 140, 146 and 173
-- valid_from is the date from which the CURRENT wording is in force; earlier dates have no
-- parameter on purpose (their wording was not checked), so nothing is computed for them.
DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-vat-rates', true);
  INSERT INTO app.legal_parameter (key, value_numeric, valid_from, valid_to, source_url, source_ref, verified_at)
  VALUES
    ('vat_rate_standard', 20, DATE '2022-07-01', NULL,
     'https://lex.bg/laws/ldoc/2135533201',
     'ЗДДС, чл. 66, ал. 1 (изм. ДВ бр. 52 от 2022 г., в сила от 01.07.2022 г.); docs/legal/vat/ZDDS-lex-bg-2026-11-27.txt',
     DATE '2026-11-27'),
    ('vat_rate_reduced_9', 9, DATE '2023-01-01', NULL,
     'https://lex.bg/laws/ldoc/2135533201',
     'ЗДДС, чл. 66а (изм. ДВ бр. 102 от 2022 г., в сила от 01.01.2023 г.), само за доставките по т. 1–3; docs/legal/vat/ZDDS-lex-bg-2026-11-27.txt',
     DATE '2026-11-27'),
    ('vat_rate_zero', 0, DATE '2022-07-01', NULL,
     'https://lex.bg/laws/ldoc/2135533201',
     'ЗДДС, чл. 66б (нов ДВ бр. 52 от 2022 г., в сила от 01.07.2022 г.): доставките по глава трета, чл. 53, 64а, 140, 146 и 173; docs/legal/vat/ZDDS-lex-bg-2026-11-27.txt',
     DATE '2026-11-27');
END
$$;

-- migrate:down

DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-vat-rates', true);
  DELETE FROM app.legal_parameter WHERE key IN ('vat_rate_standard', 'vat_rate_reduced_9', 'vat_rate_zero');
END
$$;

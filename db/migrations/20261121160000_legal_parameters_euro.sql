-- migrate:up

-- First verified legal parameter (PROMPT.md 3.1, docs/legal/README.md):
-- the fixed BGN/EUR conversion rate. Value and date verified 2026-11-21 against the
-- official EUR-Lex text of Council Regulation (EU) 2025/1409, Art. 1 ("= 1,95583
-- български лева") and Art. 2 (in force on 1 January 2026). ZVERB Art. 12 governs how it
-- is applied (full six digits, never rounded).
DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-parameters', true);
  INSERT INTO app.legal_parameter (key, value_numeric, valid_from, valid_to, source_url, source_ref, verified_at)
  VALUES (
    'eur_bgn_conversion_rate',
    1.95583,
    DATE '2026-01-01',
    NULL,
    'https://eur-lex.europa.eu/eli/reg/2025/1409/oj/bul',
    'Регламент (ЕС) 2025/1409 на Съвета, чл. 1 и 2 (ОВ L, 2025/1409, 14.7.2025); ЗВЕРБ, чл. 12',
    DATE '2026-11-21'
  );
END
$$;

-- Value of a numeric parameter on a date; NULL when none is defined (callers must then
-- refuse to compute rather than guess).
CREATE FUNCTION app.legal_numeric(p_key text, p_on date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT value_numeric FROM app.legal_parameter
  WHERE key = p_key AND valid_from <= p_on AND (valid_to IS NULL OR p_on <= valid_to)
$$;
GRANT EXECUTE ON FUNCTION app.legal_numeric(text, date) TO app_user;

-- migrate:down

DROP FUNCTION app.legal_numeric(text, date);
DO $$
BEGIN
  PERFORM set_config('app.system_actor', 'migration:legal-parameters', true);
  DELETE FROM app.legal_parameter WHERE key = 'eur_bgn_conversion_rate';
END
$$;

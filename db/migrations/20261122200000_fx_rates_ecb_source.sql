-- migrate:up

-- ============================================================================
-- ECB as the automatic source of the BNB central rates from 2026 (owner's decision
-- 2026-11-22, ADR-0012). The BNB publication of a day equals the ECB rates last published
-- by that day (verified, tests in apps/web/src/lib/fx/ecb.test.ts). An ECB-sourced row is
-- "the rate that applies to rate_date", taken from the ECB publication of source_date
-- (the same day, or the last one before it: weekend, holiday, 1.01.2026 → 31.12.2025).
-- BNB rows keep their meaning: what the BNB published (or not) that day.
-- ============================================================================

ALTER TABLE app.exchange_rate_day
  ADD COLUMN source text NOT NULL DEFAULT 'bnb' CHECK (source IN ('bnb', 'ecb')),
  ADD COLUMN source_date date;

ALTER TABLE app.exchange_rate_day DROP CONSTRAINT exchange_rate_day_source_url_check;
ALTER TABLE app.exchange_rate_day ADD CONSTRAINT exchange_rate_day_origin_check CHECK (
  (source = 'bnb' AND source_url LIKE 'https://www.bnb.bg/%' AND source_date IS NULL)
  OR (source = 'ecb' AND source_url LIKE 'https://www.ecb.europa.eu/%'
      AND status = 'published'
      AND rate_date >= DATE '2026-01-01'
      AND source_date IS NOT NULL
      AND source_date BETWEEN rate_date - 10 AND rate_date)
);

/**
 * Stores the rates that apply to one day. Same guarantees as before: checked, idempotent,
 * never overwritten (different data for a stored day is refused), audited.
 */
CREATE FUNCTION app.store_fx_rates(p_date date, p_status text, p_source text, p_source_url text,
                                   p_source_date date, p_rates jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Sofia')::date;
  v_existing app.exchange_rate_day;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Няма потребител в контекста.' USING ERRCODE = '42501';
  END IF;
  IF p_date > v_today OR (p_status = 'none' AND p_date >= v_today) THEN
    RAISE EXCEPTION 'Курсове за % още не може да се запишат.', p_date USING ERRCODE = '22023';
  END IF;
  IF p_status = 'none' AND jsonb_array_length(coalesce(p_rates, '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'Ден без публикация не може да има курсове.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'published' AND jsonb_array_length(coalesce(p_rates, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Публикуван ден без курсове.' USING ERRCODE = '22023';
  END IF;
  -- Today from the ECB only with today's own publication (the BNB follows it ~17:00).
  IF p_source = 'ecb' AND p_date = v_today AND p_source_date IS DISTINCT FROM p_date
     AND extract(isodow FROM p_date) < 6 THEN
    RAISE EXCEPTION 'Курсът за днес още не е публикуван.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing FROM app.exchange_rate_day WHERE rate_date = p_date;
  IF FOUND THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'kind', kind,
             'rate', rate, 'units', units) ORDER BY currency), '[]'::jsonb)
      INTO v_old FROM app.exchange_rate WHERE rate_date = p_date;
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', r->>'currency', 'kind', r->>'kind',
             'rate', (r->>'rate')::numeric, 'units', coalesce((r->>'units')::integer, 1))
             ORDER BY r->>'currency'), '[]'::jsonb)
      INTO v_new FROM jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r;
    -- The same rates again are fine whatever the source (the ECB and BNB values are equal).
    IF v_existing.status <> p_status OR v_old <> v_new THEN
      RAISE EXCEPTION 'За % вече има записани различни данни.', p_date USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  INSERT INTO app.exchange_rate_day (rate_date, status, source_url, source, source_date)
  VALUES (p_date, p_status, p_source_url, p_source, p_source_date);
  INSERT INTO app.exchange_rate (rate_date, currency, kind, rate, units)
  SELECT p_date, r->>'currency', r->>'kind', (r->>'rate')::numeric, coalesce((r->>'units')::integer, 1)
  FROM jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r;
END
$$;
REVOKE ALL ON FUNCTION app.store_fx_rates(date, text, text, text, date, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_fx_rates(date, text, text, text, date, jsonb) TO app_user;

-- The BNB-only entry point stays for compatibility and now delegates.
CREATE OR REPLACE FUNCTION app.store_bnb_rates(p_date date, p_status text, p_source text, p_rates jsonb)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.store_fx_rates(p_date, p_status, 'bnb', p_source, NULL, p_rates)
$$;

-- migrate:down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.exchange_rate_day WHERE source = 'ecb') THEN
    RAISE EXCEPTION 'Има курсове от ЕЦБ; връщането назад би загубило източника им.';
  END IF;
END
$$;
DROP FUNCTION app.store_fx_rates(date, text, text, text, date, jsonb);
ALTER TABLE app.exchange_rate_day DROP CONSTRAINT exchange_rate_day_origin_check;
ALTER TABLE app.exchange_rate_day DROP COLUMN source_date, DROP COLUMN source;
ALTER TABLE app.exchange_rate_day
  ADD CONSTRAINT exchange_rate_day_source_url_check CHECK (source_url LIKE 'https://www.bnb.bg/%');
-- Restore the original body of store_bnb_rates (migration 20261122160000).
CREATE OR REPLACE FUNCTION app.store_bnb_rates(p_date date, p_status text, p_source text, p_rates jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Europe/Sofia')::date;
  v_existing app.exchange_rate_day;
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'Няма потребител в контекста.' USING ERRCODE = '42501';
  END IF;
  IF p_date > v_today OR (p_status = 'none' AND p_date >= v_today) THEN
    RAISE EXCEPTION 'Курсове за % още не може да се запишат.', p_date USING ERRCODE = '22023';
  END IF;
  IF p_status = 'none' AND jsonb_array_length(coalesce(p_rates, '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'Ден без публикация не може да има курсове.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'published' AND jsonb_array_length(coalesce(p_rates, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Публикуван ден без курсове.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_existing FROM app.exchange_rate_day WHERE rate_date = p_date;
  IF FOUND THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'kind', kind,
             'rate', rate, 'units', units) ORDER BY currency), '[]'::jsonb)
      INTO v_old FROM app.exchange_rate WHERE rate_date = p_date;
    SELECT coalesce(jsonb_agg(jsonb_build_object('currency', r->>'currency', 'kind', r->>'kind',
             'rate', (r->>'rate')::numeric, 'units', coalesce((r->>'units')::integer, 1))
             ORDER BY r->>'currency'), '[]'::jsonb)
      INTO v_new FROM jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r;
    IF v_existing.status <> p_status OR v_old <> v_new THEN
      RAISE EXCEPTION 'За % вече има записани различни данни от БНБ.', p_date USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;
  INSERT INTO app.exchange_rate_day (rate_date, status, source_url) VALUES (p_date, p_status, p_source);
  INSERT INTO app.exchange_rate (rate_date, currency, kind, rate, units)
  SELECT p_date, r->>'currency', r->>'kind', (r->>'rate')::numeric, coalesce((r->>'units')::integer, 1)
  FROM jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r;
END
$$;

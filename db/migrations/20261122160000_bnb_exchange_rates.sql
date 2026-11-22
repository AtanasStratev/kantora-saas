-- migrate:up

-- ============================================================================
-- BNB central exchange rates (docs/phase2-plan.md step 8; ЗСч чл. 5, ал. 1; Валутен закон
-- чл. 12, ал. 1; format in docs/legal/README.md). Global reference data like
-- legal_parameter: readable by everyone, written only through app.store_bnb_rates(),
-- which checks the data, records the source and never overwrites a stored rate.
-- ============================================================================

-- One row per calendar day the BNB was asked about: published, or nothing published.
CREATE TABLE app.exchange_rate_day (
  rate_date   date PRIMARY KEY CHECK (rate_date >= DATE '1999-01-01'),
  status      text NOT NULL CHECK (status IN ('published', 'none')),
  source_url  text NOT NULL CHECK (source_url LIKE 'https://www.bnb.bg/%'),
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.exchange_rate (
  rate_date date NOT NULL REFERENCES app.exchange_rate_day (rate_date),
  currency  char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND currency NOT IN ('EUR', 'BGN')),
  -- per_eur (from 2026): currency units for 1 EUR; bgn_per_units (until 2025): BGN for `units`.
  kind      text NOT NULL CHECK (kind IN ('per_eur', 'bgn_per_units')),
  -- Unconstrained numeric keeps the digits exactly as the BNB published them (1.0990).
  rate      numeric NOT NULL CHECK (rate > 0 AND rate < 1e12),
  units     integer NOT NULL DEFAULT 1 CHECK (units >= 1),
  PRIMARY KEY (rate_date, currency),
  -- The quote follows the era of the date (euro adopted 1.01.2026).
  CHECK ((rate_date < DATE '2026-01-01') = (kind = 'bgn_per_units')),
  CHECK (kind = 'bgn_per_units' OR units = 1)
);
CREATE INDEX exchange_rate_currency_idx ON app.exchange_rate (currency, rate_date DESC);

ALTER TABLE app.exchange_rate_day ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.exchange_rate     ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY exchange_rate_day_select ON app.exchange_rate_day FOR SELECT TO app_user USING (true);
CREATE POLICY exchange_rate_select ON app.exchange_rate FOR SELECT TO app_user USING (true);
GRANT SELECT ON app.exchange_rate_day, app.exchange_rate TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.exchange_rate_day
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.exchange_rate
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- Stored rates are evidence: never changed or deleted (a wrong rate is corrected by a
-- reviewed migration, not by the application).
CREATE FUNCTION app.exchange_rate_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Курсовете на БНБ не се променят и не се изтриват.' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON app.exchange_rate
  FOR EACH ROW EXECUTE FUNCTION app.exchange_rate_immutable();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON app.exchange_rate_day
  FOR EACH ROW EXECUTE FUNCTION app.exchange_rate_immutable();

/**
 * Stores what the BNB answered for one day. p_rates: [{"currency","kind","rate","units"}].
 * Idempotent: the same data again is a no-op; DIFFERENT data for a stored day is refused.
 * Only days up to today (Sofia) can be stored; a "none" for today is refused, because the
 * BNB may still publish later in the day.
 */
CREATE FUNCTION app.store_bnb_rates(p_date date, p_status text, p_source text, p_rates jsonb)
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
REVOKE ALL ON FUNCTION app.store_bnb_rates(date, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.store_bnb_rates(date, text, text, jsonb) TO app_user;

-- migrate:down

DROP FUNCTION app.store_bnb_rates(date, text, text, jsonb);
DROP TABLE app.exchange_rate;
DROP TABLE app.exchange_rate_day;
DROP FUNCTION app.exchange_rate_immutable();

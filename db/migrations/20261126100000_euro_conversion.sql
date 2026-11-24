-- migrate:up

-- ============================================================================
-- BGN → EUR conversion of the balances at the euro introduction date
-- (docs/phase2-plan.md step 13, ADR-0016; ЗВЕРБ чл. 12, 13, 45, 48 and the evroto.bg
-- guidelines, section IV, in docs/legal/README.md).
--   * The closing balances of the BGN year are converted position by position (account,
--     counterparty, document, cost object, currency) and posted as OPENING lines of the
--     EUR year (journal_line.is_opening). Reports show opening lines as opening balances.
--   * The rounding differences are posted in the same entry as ordinary lines: to
--     current income/expense (чл. 48, ал. 4), the part of the equity accounts to equity
--     (чл. 48, ал. 6).
-- ============================================================================

-- How an account's balances are converted: standard (чл. 12–13), equity (differences to
-- equity, чл. 48, ал. 6) or wages (rounded up from the third decimal, чл. 45 via чл. 48, ал. 2).
ALTER TABLE app.account ADD COLUMN euro_conversion text NOT NULL DEFAULT 'standard'
  CHECK (euro_conversion IN ('standard', 'equity', 'wages'));

ALTER TABLE app.journal_line ADD COLUMN is_opening boolean NOT NULL DEFAULT false;

CREATE TABLE app.euro_conversion_run (
  office_id         uuid NOT NULL,
  company_id        uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  from_year_id      uuid NOT NULL,
  to_year_id        uuid NOT NULL,
  entry_id          uuid NOT NULL UNIQUE,
  gain_account_id   uuid NOT NULL,
  loss_account_id   uuid NOT NULL,
  equity_account_id uuid NOT NULL,
  -- The BGN positions that were converted: shows later whether the BGN year changed.
  source            jsonb NOT NULL,
  created_by        uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, from_year_id) REFERENCES app.fiscal_year (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, to_year_id) REFERENCES app.fiscal_year (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, entry_id) REFERENCES app.journal_entry (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, gain_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, loss_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, equity_account_id) REFERENCES app.account (office_id, company_id, id)
);

-- A run converts a BGN year into the next, EUR, year; its entry is dated the first day of
-- the EUR year; only one run is in force at a time (a new one after reversing the old).
CREATE FUNCTION app.guard_euro_conversion_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  f app.fiscal_year%ROWTYPE;
  t app.fiscal_year%ROWTYPE;
  e app.journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO f FROM app.fiscal_year WHERE id = NEW.from_year_id;
  SELECT * INTO t FROM app.fiscal_year WHERE id = NEW.to_year_id;
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.entry_id;
  IF f.ledger_currency <> 'BGN' OR t.ledger_currency <> 'EUR' OR t.year <> f.year + 1 THEN
    RAISE EXCEPTION 'Превалутирането е от година в лева към следващата година в евро.'
      USING ERRCODE = '23514';
  END IF;
  IF e.entry_date <> t.start_date THEN
    RAISE EXCEPTION 'Статията за превалутиране е с дата първия ден на годината в евро.'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.euro_conversion_run r
     WHERE r.to_year_id = NEW.to_year_id
       AND NOT EXISTS (SELECT 1 FROM app.journal_entry x WHERE x.reverses_entry_id = r.entry_id)
  ) THEN
    RAISE EXCEPTION 'Превалутирането вече е направено. За ново първо сторнирайте старата статия.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT ON app.euro_conversion_run
  FOR EACH ROW EXECUTE FUNCTION app.guard_euro_conversion_run();

-- Opening lines only in a conversion run's entry (or its reversal), dated the first day of
-- the year. Checked at COMMIT, like Dt = Кт.
CREATE FUNCTION app.check_entry_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted'
     OR NOT EXISTS (SELECT 1 FROM app.journal_line WHERE entry_id = NEW.id AND is_opening) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.euro_conversion_run
                  WHERE entry_id = coalesce(e.reverses_entry_id, e.id)) THEN
    RAISE EXCEPTION 'Редове за начални салда се създават само от превалутирането.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER opening_lines AFTER INSERT OR UPDATE ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_opening();

-- The conversion entry, like a revaluation, may carry a currency position whose amount in
-- the currency is 0 (settled in the currency, not in leva).
CREATE OR REPLACE FUNCTION app.check_entry_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  v_ledger text;
  v_reval boolean;
  bad record;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted' OR e.reverses_entry_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT fy.ledger_currency INTO v_ledger
    FROM app.period p JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id
   WHERE p.id = e.period_id;
  v_reval := EXISTS (SELECT 1 FROM app.fx_revaluation_run WHERE entry_id = NEW.id)
          OR EXISTS (SELECT 1 FROM app.euro_conversion_run WHERE entry_id = NEW.id);
  SELECT l.line_no, a.code, l.doc_currency, l.doc_amount INTO bad
    FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
   WHERE l.entry_id = NEW.id AND a.is_currency
     AND (l.doc_currency IS NULL OR l.doc_currency = v_ledger
          OR (NOT v_reval AND l.doc_amount <= 0))
   ORDER BY l.line_no LIMIT 1;
  IF FOUND THEN
    IF bad.doc_currency IS NULL THEN
      RAISE EXCEPTION 'Ред %: сметка % е валутна: въведете валута и сума във валута.',
        bad.line_no, bad.code USING ERRCODE = '23514';
    ELSIF bad.doc_currency = v_ledger THEN
      RAISE EXCEPTION 'Ред %: % е отчетната валута на годината, а сметка % е за чуждестранна валута.',
        bad.line_no, v_ledger, bad.code USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION 'Ред %: сумата във валута по сметка % трябва да е положителна.',
        bad.line_no, bad.code USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;

-- The conversion entry carries the BGN year's positions as they are: like a reversal, it is
-- not re-checked against the analytics the accounts need today.
CREATE OR REPLACE FUNCTION app.check_entry_analytics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  bad record;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted' OR e.reverses_entry_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM app.euro_conversion_run WHERE entry_id = NEW.id) THEN
    RETURN NULL;
  END IF;
  SELECT l.line_no, a.code,
         a.needs_counterparty AND l.counterparty_id IS NULL AS no_cp,
         a.needs_document AND l.document_number IS NULL AS no_doc,
         a.needs_cost_object AND l.cost_object_id IS NULL AS no_obj
    INTO bad
    FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
   WHERE l.entry_id = NEW.id
     AND ((a.needs_counterparty AND l.counterparty_id IS NULL)
       OR (a.needs_document AND l.document_number IS NULL)
       OR (a.needs_cost_object AND l.cost_object_id IS NULL))
   ORDER BY l.line_no LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ред %: сметка % изисква %. Статията не е осчетоводена.', bad.line_no, bad.code,
      CASE WHEN bad.no_cp THEN 'контрагент' WHEN bad.no_doc THEN 'документ' ELSE 'обект' END
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

-- The year before (or after) the existing ones, with its 12 periods; the ledger currency
-- follows the era (BGN until 2025). For bringing in the BGN year before the conversion.
CREATE FUNCTION app.add_fiscal_year(p_year int) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_office uuid := app.current_office_id();
  v_company uuid := app.current_company_id();
  v_min int;
  v_max int;
  v_fy uuid;
  m int;
BEGIN
  IF NOT coalesce(app.has_company_access(v_office, v_company), false) OR NOT app.can_manage_chart() THEN
    RAISE EXCEPTION 'Нямате право да добавяте години в тази фирма.' USING ERRCODE = '42501';
  END IF;
  SELECT min(year), max(year) INTO v_min, v_max FROM app.fiscal_year
   WHERE office_id = v_office AND company_id = v_company;
  IF p_year IS NULL OR p_year < 2000 OR (v_min IS NOT NULL AND p_year <> v_min - 1 AND p_year <> v_max + 1) THEN
    RAISE EXCEPTION 'Може да се добави само годината преди или след съществуващите.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.fiscal_year (office_id, company_id, year, start_date, end_date, ledger_currency)
  VALUES (v_office, v_company, p_year, make_date(p_year, 1, 1), make_date(p_year, 12, 31),
          CASE WHEN p_year <= 2025 THEN 'BGN' ELSE 'EUR' END::app.ledger_currency)
  RETURNING id INTO v_fy;
  FOR m IN 1..12 LOOP
    INSERT INTO app.period (office_id, company_id, fiscal_year_id, month, start_date, end_date)
    VALUES (v_office, v_company, v_fy, m, make_date(p_year, m, 1),
            (make_date(p_year, m, 1) + interval '1 month - 1 day')::date);
  END LOOP;
  RETURN v_fy;
END
$$;
GRANT EXECUTE ON FUNCTION app.add_fiscal_year(int) TO app_user;

ALTER TABLE app.euro_conversion_run ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY euro_conversion_run_select ON app.euro_conversion_run FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY euro_conversion_run_insert ON app.euro_conversion_run FOR INSERT TO app_user
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_manage_chart()));
GRANT SELECT, INSERT ON app.euro_conversion_run TO app_user;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.euro_conversion_run
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

CREATE OR REPLACE FUNCTION app.check_entry_analytics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  bad record;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted' OR e.reverses_entry_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT l.line_no, a.code,
         a.needs_counterparty AND l.counterparty_id IS NULL AS no_cp,
         a.needs_document AND l.document_number IS NULL AS no_doc,
         a.needs_cost_object AND l.cost_object_id IS NULL AS no_obj
    INTO bad
    FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
   WHERE l.entry_id = NEW.id
     AND ((a.needs_counterparty AND l.counterparty_id IS NULL)
       OR (a.needs_document AND l.document_number IS NULL)
       OR (a.needs_cost_object AND l.cost_object_id IS NULL))
   ORDER BY l.line_no LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Ред %: сметка % изисква %. Статията не е осчетоводена.', bad.line_no, bad.code,
      CASE WHEN bad.no_cp THEN 'контрагент' WHEN bad.no_doc THEN 'документ' ELSE 'обект' END
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP FUNCTION app.add_fiscal_year(int);
CREATE OR REPLACE FUNCTION app.check_entry_currency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  v_ledger text;
  v_reval boolean;
  bad record;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted' OR e.reverses_entry_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT fy.ledger_currency INTO v_ledger
    FROM app.period p JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id
   WHERE p.id = e.period_id;
  v_reval := EXISTS (SELECT 1 FROM app.fx_revaluation_run WHERE entry_id = NEW.id);
  SELECT l.line_no, a.code, l.doc_currency, l.doc_amount INTO bad
    FROM app.journal_line l JOIN app.account a ON a.id = l.account_id
   WHERE l.entry_id = NEW.id AND a.is_currency
     AND (l.doc_currency IS NULL OR l.doc_currency = v_ledger
          OR (NOT v_reval AND l.doc_amount <= 0))
   ORDER BY l.line_no LIMIT 1;
  IF FOUND THEN
    IF bad.doc_currency IS NULL THEN
      RAISE EXCEPTION 'Ред %: сметка % е валутна: въведете валута и сума във валута.',
        bad.line_no, bad.code USING ERRCODE = '23514';
    ELSIF bad.doc_currency = v_ledger THEN
      RAISE EXCEPTION 'Ред %: % е отчетната валута на годината, а сметка % е за чуждестранна валута.',
        bad.line_no, v_ledger, bad.code USING ERRCODE = '23514';
    ELSE
      RAISE EXCEPTION 'Ред %: сумата във валута по сметка % трябва да е положителна.',
        bad.line_no, bad.code USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER opening_lines ON app.journal_entry;
DROP FUNCTION app.check_entry_opening();
DROP TABLE app.euro_conversion_run;
DROP FUNCTION app.guard_euro_conversion_run();
ALTER TABLE app.journal_line DROP COLUMN is_opening;
ALTER TABLE app.account DROP COLUMN euro_conversion;

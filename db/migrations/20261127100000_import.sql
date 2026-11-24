-- migrate:up

-- ============================================================================
-- Import from the program's Excel template (docs/phase2-plan.md step 14, ADR-0017).
--   * import_run records each import (file name and SHA-256, what it contained); the
--     entries it posted point to it.
--   * An import may bring the opening balances of a year (opening lines, like the BGN → EUR
--     conversion). A year has one set of opening balances in force at a time.
--   * Fix: a reversal now keeps the opening flag of its lines, so reversing an opening
--     entry also reverses the opening balances (before, the reversal landed in the
--     turnover of January).
-- ============================================================================

CREATE TABLE app.import_run (
  office_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  file_name       text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_sha256     text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- What the file contained (counts per sheet), for the record.
  summary         jsonb NOT NULL,
  -- The year whose opening balances this import brings (NULL: none).
  opening_year_id uuid,
  created_by      uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, opening_year_id) REFERENCES app.fiscal_year (office_id, company_id, id)
);

ALTER TABLE app.journal_entry
  ADD COLUMN import_run_id uuid,
  ADD CONSTRAINT journal_entry_import_run_fk FOREIGN KEY (office_id, company_id, import_run_id)
    REFERENCES app.import_run (office_id, company_id, id);
CREATE INDEX journal_entry_import_run_idx ON app.journal_entry (import_run_id) WHERE import_run_id IS NOT NULL;

-- Opening lines: from the BGN → EUR conversion or from an import of opening balances, dated
-- the first day of the year; only one set in force per year.
CREATE OR REPLACE FUNCTION app.check_entry_opening() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  o app.journal_entry%ROWTYPE;
  fy app.fiscal_year%ROWTYPE;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.id;
  IF e.status IS DISTINCT FROM 'posted'
     OR NOT EXISTS (SELECT 1 FROM app.journal_line WHERE entry_id = NEW.id AND is_opening) THEN
    RETURN NULL;
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    RETURN NULL; -- a reversal mirrors an opening entry that was allowed
  END IF;
  SELECT fy2.* INTO fy FROM app.period p JOIN app.fiscal_year fy2 ON fy2.id = p.fiscal_year_id
   WHERE p.id = e.period_id;
  IF NOT EXISTS (SELECT 1 FROM app.euro_conversion_run WHERE entry_id = e.id)
     AND NOT EXISTS (SELECT 1 FROM app.import_run r
                      WHERE r.id = e.import_run_id AND r.opening_year_id = fy.id) THEN
    RAISE EXCEPTION 'Редове за начални салда се създават само от превалутирането или от вноса на начални салда.'
      USING ERRCODE = '23514';
  END IF;
  IF e.entry_date <> fy.start_date THEN
    RAISE EXCEPTION 'Началните салда са с дата първия ден на годината (%).',
      to_char(fy.start_date, 'DD.MM.YYYY') USING ERRCODE = '23514';
  END IF;
  -- Another opening entry of the year still in force?
  SELECT x.* INTO o FROM app.journal_entry x JOIN app.period p ON p.id = x.period_id
   WHERE p.fiscal_year_id = fy.id AND x.id <> e.id AND x.status = 'posted'
     AND x.reverses_entry_id IS NULL
     AND EXISTS (SELECT 1 FROM app.journal_line l WHERE l.entry_id = x.id AND l.is_opening)
     AND NOT EXISTS (SELECT 1 FROM app.journal_entry r WHERE r.reverses_entry_id = x.id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Годината вече има начални салда (статия № %). Първо я сторнирайте.', o.number
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION app.reverse_entry(p_entry_id uuid, p_date date, p_description text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  v_period uuid;
  v_new uuid;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Статията не е намерена.' USING ERRCODE = '22023';
  END IF;
  IF e.status <> 'posted' THEN
    RAISE EXCEPTION 'Само осчетоводена статия се сторнира. Черновата може да се изтрие.'
      USING ERRCODE = '22023';
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Това вече е сторно. Сторнирайте оригиналната статия при нужда от нова корекция.'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM app.journal_entry WHERE reverses_entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'Статията вече е сторнирана.' USING ERRCODE = '22023';
  END IF;
  SELECT p.id INTO v_period FROM app.period p
    JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id
   WHERE p.company_id = e.company_id AND p_date BETWEEN p.start_date AND p.end_date;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'Няма период за дата %.', to_char(p_date, 'DD.MM.YYYY') USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description,
                                 reverses_entry_id, created_by)
  VALUES (e.office_id, e.company_id, v_period, p_date,
          coalesce(p_description, 'Сторно на статия № ' || e.number), p_entry_id, app.current_user_id())
  RETURNING id INTO v_new;
  INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                description, doc_currency, doc_amount, fx_rate,
                                counterparty_id, document_number, document_date, cost_object_id,
                                is_opening)
  SELECT office_id, company_id, v_new, line_no, account_id,
         CASE side WHEN 'D' THEN 'C'::app.entry_side ELSE 'D'::app.entry_side END,
         amount, description, doc_currency, doc_amount, fx_rate,
         counterparty_id, document_number, document_date, cost_object_id, is_opening
    FROM app.journal_line WHERE entry_id = p_entry_id;
  UPDATE app.journal_entry SET status = 'posted' WHERE id = v_new;
  RETURN v_new;
END
$$;

ALTER TABLE app.import_run ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY import_run_select ON app.import_run FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY import_run_insert ON app.import_run FOR INSERT TO app_user
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_manage_chart()));
GRANT SELECT, INSERT ON app.import_run TO app_user;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.import_run
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

CREATE OR REPLACE FUNCTION app.reverse_entry(p_entry_id uuid, p_date date, p_description text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  v_period uuid;
  v_new uuid;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Статията не е намерена.' USING ERRCODE = '22023';
  END IF;
  IF e.status <> 'posted' THEN
    RAISE EXCEPTION 'Само осчетоводена статия се сторнира. Черновата може да се изтрие.'
      USING ERRCODE = '22023';
  END IF;
  IF e.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Това вече е сторно. Сторнирайте оригиналната статия при нужда от нова корекция.'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM app.journal_entry WHERE reverses_entry_id = p_entry_id) THEN
    RAISE EXCEPTION 'Статията вече е сторнирана.' USING ERRCODE = '22023';
  END IF;
  SELECT p.id INTO v_period FROM app.period p
    JOIN app.fiscal_year fy ON fy.id = p.fiscal_year_id
   WHERE p.company_id = e.company_id AND p_date BETWEEN p.start_date AND p.end_date;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'Няма период за дата %.', to_char(p_date, 'DD.MM.YYYY') USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.journal_entry (office_id, company_id, period_id, entry_date, description,
                                 reverses_entry_id, created_by)
  VALUES (e.office_id, e.company_id, v_period, p_date,
          coalesce(p_description, 'Сторно на статия № ' || e.number), p_entry_id, app.current_user_id())
  RETURNING id INTO v_new;
  INSERT INTO app.journal_line (office_id, company_id, entry_id, line_no, account_id, side, amount,
                                description, doc_currency, doc_amount, fx_rate,
                                counterparty_id, document_number, document_date, cost_object_id)
  SELECT office_id, company_id, v_new, line_no, account_id,
         CASE side WHEN 'D' THEN 'C'::app.entry_side ELSE 'D'::app.entry_side END,
         amount, description, doc_currency, doc_amount, fx_rate,
         counterparty_id, document_number, document_date, cost_object_id
    FROM app.journal_line WHERE entry_id = p_entry_id;
  UPDATE app.journal_entry SET status = 'posted' WHERE id = v_new;
  RETURN v_new;
END
$$;

CREATE OR REPLACE FUNCTION app.check_entry_opening() RETURNS trigger
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

ALTER TABLE app.journal_entry DROP CONSTRAINT journal_entry_import_run_fk;
DROP INDEX app.journal_entry_import_run_idx;
ALTER TABLE app.journal_entry DROP COLUMN import_run_id;
DROP TABLE app.import_run;

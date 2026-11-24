-- migrate:up

-- ============================================================================
-- Foreign-currency items and their revaluation (docs/phase2-plan.md step 12, ADR-0015;
-- СС 21, т. 3.4–3.5, 4.2 in docs/legal/README.md).
--   * An account marked is_currency holds monetary items in a foreign currency: every
--     line on it carries the currency and the amount in that currency.
--   * A revaluation is an ordinary posted entry (Dt = Кт, locked periods, reversal all
--     apply) recorded in fx_revaluation_run; its lines on currency accounts carry the
--     currency with amount 0 in that currency (only the value in the ledger currency
--     changes).
-- ============================================================================

ALTER TABLE app.account ADD COLUMN is_currency boolean NOT NULL DEFAULT false;

ALTER TABLE app.journal_line
  ADD CONSTRAINT journal_line_doc_amount_check CHECK (doc_amount >= 0);

CREATE TABLE app.fx_revaluation_run (
  office_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id       uuid NOT NULL,
  rate_date       date NOT NULL,
  entry_id        uuid NOT NULL UNIQUE,
  gain_account_id uuid NOT NULL,
  loss_account_id uuid NOT NULL,
  created_by      uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, period_id) REFERENCES app.period (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, entry_id) REFERENCES app.journal_entry (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, gain_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, loss_account_id) REFERENCES app.account (office_id, company_id, id)
);
CREATE INDEX fx_revaluation_run_period_idx ON app.fx_revaluation_run (company_id, period_id);

-- At COMMIT: lines on currency accounts carry a foreign currency (not the ledger currency
-- of the year) and, except in a revaluation, a positive amount in it. Reversals mirror
-- their original and are not re-checked.
CREATE FUNCTION app.check_entry_currency() RETURNS trigger
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
CREATE CONSTRAINT TRIGGER currency_complete AFTER INSERT OR UPDATE ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_currency();

-- A run belongs to a posted-at-commit entry of the same period, dated the period's last day.
CREATE FUNCTION app.guard_fx_revaluation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  p app.period%ROWTYPE;
BEGIN
  SELECT * INTO e FROM app.journal_entry WHERE id = NEW.entry_id;
  SELECT * INTO p FROM app.period WHERE id = NEW.period_id;
  IF e.period_id <> NEW.period_id OR e.entry_date <> p.end_date OR NEW.rate_date <> p.end_date THEN
    RAISE EXCEPTION 'Преоценката е към последния ден на периода.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT ON app.fx_revaluation_run
  FOR EACH ROW EXECUTE FUNCTION app.guard_fx_revaluation_run();

ALTER TABLE app.fx_revaluation_run ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY fx_revaluation_run_select ON app.fx_revaluation_run FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY fx_revaluation_run_insert ON app.fx_revaluation_run FOR INSERT TO app_user
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_post_accounting()));
-- A run is a record of what was posted: never changed or deleted (the entry is reversed).
GRANT SELECT, INSERT ON app.fx_revaluation_run TO app_user;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.fx_revaluation_run
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

DROP TABLE app.fx_revaluation_run;
DROP FUNCTION app.guard_fx_revaluation_run();
DROP TRIGGER currency_complete ON app.journal_entry;
DROP FUNCTION app.check_entry_currency();
ALTER TABLE app.journal_line DROP CONSTRAINT journal_line_doc_amount_check;
ALTER TABLE app.account DROP COLUMN is_currency;

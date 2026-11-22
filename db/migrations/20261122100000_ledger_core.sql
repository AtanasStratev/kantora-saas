-- migrate:up

-- ============================================================================
-- Ledger core (PROMPT.md 3.3, docs/phase2-plan.md step 1): accounts, journal entries and
-- lines. The database itself guarantees: Dt = Кт for posted entries, posted entries are
-- immutable (corrections by reversal), nothing changes in a locked period, the entry date
-- lies in its period, lines use postable accounts of the same company.
-- ============================================================================

-- Who may read / post accounting data in the current office (mirrors domain/permissions.ts).
CREATE FUNCTION app.can_view_accounting() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_office_role() IN ('owner', 'chief_accountant', 'accountant', 'read_only')
$$;
CREATE FUNCTION app.can_post_accounting() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_office_role() IN ('owner', 'chief_accountant', 'accountant')
$$;
CREATE FUNCTION app.can_manage_chart() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT app.current_office_role() IN ('owner', 'chief_accountant')
$$;
GRANT EXECUTE ON FUNCTION app.can_view_accounting(), app.can_post_accounting(),
  app.can_manage_chart() TO app_user;

CREATE TYPE app.entry_side AS ENUM ('D', 'C');
CREATE TYPE app.entry_status AS ENUM ('draft', 'posted');

CREATE TABLE app.account (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[0-9A-Za-z][0-9A-Za-z./-]*$'),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  parent_id   uuid,
  is_postable boolean NOT NULL DEFAULT true,
  is_active   boolean NOT NULL DEFAULT true,
  -- SAF-T standard account code: required for SAF-T (phase 8); filled when the official
  -- nomenclature is in docs/legal/saf-t (docs/data-model.md §10).
  saft_account_code text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, parent_id) REFERENCES app.account (office_id, company_id, id)
);

CREATE TABLE app.journal_entry (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  period_id   uuid NOT NULL,
  number      integer,                       -- assigned on posting, per company and year
  entry_date  date NOT NULL,
  description text NOT NULL DEFAULT '',
  status      app.entry_status NOT NULL DEFAULT 'draft',
  reverses_entry_id uuid UNIQUE,            -- an entry is reversed at most once
  created_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  posted_by   uuid REFERENCES app.users (id),
  posted_at   timestamptz,
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, period_id) REFERENCES app.period (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, reverses_entry_id)
    REFERENCES app.journal_entry (office_id, company_id, id),
  CHECK ((status = 'posted') = (number IS NOT NULL AND posted_at IS NOT NULL AND posted_by IS NOT NULL))
);
CREATE INDEX journal_entry_company_period_idx ON app.journal_entry (company_id, period_id);
CREATE INDEX journal_entry_company_date_idx ON app.journal_entry (company_id, entry_date);

CREATE TABLE app.journal_line (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  entry_id    uuid NOT NULL,
  line_no     integer NOT NULL CHECK (line_no > 0),
  account_id  uuid NOT NULL,
  side        app.entry_side NOT NULL,
  amount      numeric(19, 2) NOT NULL CHECK (amount > 0),
  description text NOT NULL DEFAULT '',
  doc_currency char(3) CHECK (doc_currency ~ '^[A-Z]{3}$'),
  doc_amount  numeric(19, 2),
  fx_rate     numeric(19, 10) CHECK (fx_rate > 0),
  PRIMARY KEY (entry_id, line_no),
  FOREIGN KEY (office_id, company_id, entry_id)
    REFERENCES app.journal_entry (office_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (office_id, company_id, account_id) REFERENCES app.account (office_id, company_id, id),
  CHECK ((doc_currency IS NULL) = (doc_amount IS NULL))
);
CREATE INDEX journal_line_account_idx ON app.journal_line (company_id, account_id);

-- ---------------------------------------------------------------------------
-- Integrity triggers (no role exceptions: imports and jobs obey them too)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.period_is_locked(p_period_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT locked_at IS NOT NULL FROM app.period WHERE id = p_period_id
$$;

-- Entries: locked periods, date inside the period, posted entries immutable, numbering.
CREATE FUNCTION app.guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  p app.period%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND app.period_is_locked(OLD.period_id) THEN
    RAISE EXCEPTION 'Периодът е заключен: статията не може да се променя или изтрива.'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Осчетоводена статия не се изтрива. Използвайте сторно.' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF app.period_is_locked(NEW.period_id) THEN
    RAISE EXCEPTION 'Периодът е заключен: в него не могат да се добавят статии.' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO p FROM app.period WHERE id = NEW.period_id;
  IF NEW.entry_date < p.start_date OR NEW.entry_date > p.end_date THEN
    RAISE EXCEPTION 'Датата % е извън периода (% – %).',
      to_char(NEW.entry_date, 'DD.MM.YYYY'), to_char(p.start_date, 'DD.MM.YYYY'),
      to_char(p.end_date, 'DD.MM.YYYY') USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Статия се създава като чернова и се осчетоводява след въвеждане на редовете.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Осчетоводена статия не се променя. Използвайте сторно.' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'posted' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('journal-number:' || NEW.company_id::text, 0));
    SELECT coalesce(max(e.number), 0) + 1 INTO NEW.number
      FROM app.journal_entry e JOIN app.period ep ON ep.id = e.period_id
     WHERE e.company_id = NEW.company_id AND ep.fiscal_year_id = p.fiscal_year_id;
    NEW.posted_at := now();
    NEW.posted_by := app.current_user_id();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON app.journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_entry();

-- Lines: only on drafts in open periods, with postable active accounts.
CREATE FUNCTION app.guard_journal_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  e app.journal_entry%ROWTYPE;
  a app.account%ROWTYPE;
  v_entry uuid;
BEGIN
  FOREACH v_entry IN ARRAY (
    CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.entry_id]
               WHEN 'DELETE' THEN ARRAY[OLD.entry_id]
               ELSE ARRAY[OLD.entry_id, NEW.entry_id] END
  ) LOOP
    SELECT * INTO e FROM app.journal_entry WHERE id = v_entry;
    IF NOT FOUND THEN
      CONTINUE; -- the entry itself is being deleted (draft cascade)
    END IF;
    IF app.period_is_locked(e.period_id) THEN
      RAISE EXCEPTION 'Периодът е заключен: редовете на статията не могат да се променят.'
        USING ERRCODE = '23514';
    END IF;
    IF e.status = 'posted' THEN
      RAISE EXCEPTION 'Осчетоводена статия не се променя. Използвайте сторно.' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  SELECT * INTO a FROM app.account WHERE id = NEW.account_id;
  IF NOT a.is_postable THEN
    RAISE EXCEPTION 'Сметка % е групова. Изберете подсметка.', a.code USING ERRCODE = '23514';
  END IF;
  IF NOT a.is_active THEN
    RAISE EXCEPTION 'Сметка % е неактивна.', a.code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON app.journal_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_line();

-- Dt = Кт, checked at COMMIT for every entry that became posted (deferred).
CREATE FUNCTION app.check_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_status app.entry_status;
  v_debit numeric;
  v_credit numeric;
  v_lines int;
BEGIN
  SELECT status INTO v_status FROM app.journal_entry WHERE id = NEW.id;
  IF v_status IS DISTINCT FROM 'posted' THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(amount) FILTER (WHERE side = 'D'), 0),
         coalesce(sum(amount) FILTER (WHERE side = 'C'), 0)
    INTO v_lines, v_debit, v_credit
    FROM app.journal_line WHERE entry_id = NEW.id;
  IF v_lines < 2 OR v_debit = 0 OR v_credit = 0 THEN
    RAISE EXCEPTION 'Осчетоводената статия трябва да има поне един ред по дебита и един по кредита.'
      USING ERRCODE = '23514';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'Дебитът (%) не е равен на кредита (%). Статията не е осчетоводена.',
      v_debit, v_credit USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER balanced AFTER INSERT OR UPDATE ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_balanced();

-- Reversal: a new posted entry with opposite sides, linked to the original. Runs with the
-- caller's rights, so RLS and every trigger above still apply.
CREATE FUNCTION app.reverse_entry(p_entry_id uuid, p_date date, p_description text DEFAULT NULL)
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
                                description, doc_currency, doc_amount, fx_rate)
  SELECT office_id, company_id, v_new, line_no, account_id,
         CASE side WHEN 'D' THEN 'C'::app.entry_side ELSE 'D'::app.entry_side END,
         amount, description, doc_currency, doc_amount, fx_rate
    FROM app.journal_line WHERE entry_id = p_entry_id;
  UPDATE app.journal_entry SET status = 'posted' WHERE id = v_new;
  RETURN v_new;
END
$$;
GRANT EXECUTE ON FUNCTION app.reverse_entry(uuid, date, text) TO app_user;

-- ---------------------------------------------------------------------------
-- RLS, grants, audit
-- ---------------------------------------------------------------------------
ALTER TABLE app.account       ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.journal_entry ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.journal_line  ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY account_select ON app.account FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());
CREATE POLICY account_write ON app.account FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_manage_chart())
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id) AND app.can_manage_chart());

CREATE POLICY entry_select ON app.journal_entry FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());
CREATE POLICY entry_write ON app.journal_entry FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

CREATE POLICY line_select ON app.journal_line FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());
CREATE POLICY line_write ON app.journal_line FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

GRANT SELECT, INSERT, UPDATE ON app.account TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.journal_entry, app.journal_line TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.account
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.journal_line
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

DROP FUNCTION app.reverse_entry(uuid, date, text);
DROP TABLE app.journal_line;
DROP TABLE app.journal_entry;
DROP TABLE app.account;
DROP FUNCTION app.check_entry_balanced();
DROP FUNCTION app.guard_journal_line();
DROP FUNCTION app.guard_journal_entry();
DROP FUNCTION app.period_is_locked(uuid);
DROP TYPE app.entry_status;
DROP TYPE app.entry_side;
DROP FUNCTION app.can_manage_chart();
DROP FUNCTION app.can_post_accounting();
DROP FUNCTION app.can_view_accounting();

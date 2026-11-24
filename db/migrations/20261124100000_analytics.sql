-- migrate:up

-- ============================================================================
-- Analytics (docs/phase2-plan.md step 11, ADR-0014): counterparties, cost objects and
-- the analytic fields of a journal line (counterparty, document, cost object). An
-- account says which analytics it needs; the database refuses to POST an entry whose
-- line lacks one (deferred, like Dt = Кт). Drafts may be incomplete while typed.
-- Quantities come with units of measure (later step); individuals (EGN) wait for field
-- encryption (ADR-0007), so a counterparty here is an entity with an optional EIK.
-- ============================================================================

CREATE TABLE app.counterparty (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  -- Format only (9 or 13 digits). The check digit waits for its official source
  -- (docs/legal/README.md, "Контролна цифра на ЕИК/БУЛСТАТ").
  eik         text CHECK (eik ~ '^([0-9]{9}|[0-9]{13})$'),
  -- Shape only: country prefix + 2..13 letters/digits. VIES check is a later step.
  vat_number  text CHECK (vat_number ~ '^[A-Z]{2}[0-9A-Z]{2,13}$'),
  country     char(2) NOT NULL DEFAULT 'BG' CHECK (country ~ '^[A-Z]{2}$'),
  address     text NOT NULL DEFAULT '' CHECK (length(address) <= 300),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX counterparty_company_eik_key ON app.counterparty (company_id, eik)
  WHERE eik IS NOT NULL;

CREATE TABLE app.cost_object (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  code        text NOT NULL CHECK (code ~ '^[0-9A-Za-zА-Яа-я][0-9A-Za-zА-Яа-я./-]{0,29}$'),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  UNIQUE (company_id, code),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.account
  ADD COLUMN needs_counterparty boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_document     boolean NOT NULL DEFAULT false,
  ADD COLUMN needs_cost_object  boolean NOT NULL DEFAULT false;

ALTER TABLE app.journal_line
  ADD COLUMN counterparty_id uuid,
  ADD COLUMN document_number text CHECK (length(trim(document_number)) BETWEEN 1 AND 50),
  ADD COLUMN document_date   date,
  ADD COLUMN cost_object_id  uuid,
  ADD CONSTRAINT journal_line_counterparty_fk FOREIGN KEY (office_id, company_id, counterparty_id)
    REFERENCES app.counterparty (office_id, company_id, id),
  ADD CONSTRAINT journal_line_cost_object_fk FOREIGN KEY (office_id, company_id, cost_object_id)
    REFERENCES app.cost_object (office_id, company_id, id),
  ADD CONSTRAINT journal_line_document_date_check
    CHECK (document_date IS NULL OR document_number IS NOT NULL);
CREATE INDEX journal_line_counterparty_idx ON app.journal_line (company_id, counterparty_id)
  WHERE counterparty_id IS NOT NULL;
CREATE INDEX journal_line_cost_object_idx ON app.journal_line (company_id, cost_object_id)
  WHERE cost_object_id IS NOT NULL;

-- A new line may not use an inactive counterparty or cost object. A reversal mirrors its
-- original exactly, so its lines are exempt.
CREATE FUNCTION app.guard_journal_line_analytics() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF (SELECT reverses_entry_id FROM app.journal_entry WHERE id = NEW.entry_id) IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.counterparty_id IS NOT NULL
     AND NEW.counterparty_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.counterparty_id END)
     AND NOT (SELECT is_active FROM app.counterparty WHERE id = NEW.counterparty_id) THEN
    RAISE EXCEPTION 'Контрагентът е неактивен.' USING ERRCODE = '23514';
  END IF;
  IF NEW.cost_object_id IS NOT NULL
     AND NEW.cost_object_id IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.cost_object_id END)
     AND NOT (SELECT is_active FROM app.cost_object WHERE id = NEW.cost_object_id) THEN
    RAISE EXCEPTION 'Обектът е неактивен.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard_analytics BEFORE INSERT OR UPDATE ON app.journal_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_journal_line_analytics();

-- At COMMIT: every line of a posted entry carries the analytics its account needs.
-- A reversal copies the original's lines as they are, so it is not re-checked (the
-- account's needs may have changed since the original was posted).
CREATE FUNCTION app.check_entry_analytics() RETURNS trigger
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
CREATE CONSTRAINT TRIGGER analytics_complete AFTER INSERT OR UPDATE ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_entry_analytics();

-- Reversal now copies the analytic fields too (otherwise the reversal would leave the
-- counterparty's balance wrong). Same signature and checks as before.
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

-- ---------------------------------------------------------------------------
-- RLS (access functions in (SELECT ...): evaluated once per query, ADR-0013), grants, audit
-- ---------------------------------------------------------------------------
ALTER TABLE app.counterparty ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.cost_object  ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY counterparty_select ON app.counterparty FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY counterparty_write ON app.counterparty FOR ALL TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_post_accounting()))
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_post_accounting()));

CREATE POLICY cost_object_select ON app.cost_object FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY cost_object_write ON app.cost_object FOR ALL TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_manage_chart()))
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_manage_chart()));

-- No DELETE: lines reference them; they are deactivated instead.
GRANT SELECT, INSERT, UPDATE ON app.counterparty, app.cost_object TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.counterparty
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.cost_object
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
                                description, doc_currency, doc_amount, fx_rate)
  SELECT office_id, company_id, v_new, line_no, account_id,
         CASE side WHEN 'D' THEN 'C'::app.entry_side ELSE 'D'::app.entry_side END,
         amount, description, doc_currency, doc_amount, fx_rate
    FROM app.journal_line WHERE entry_id = p_entry_id;
  UPDATE app.journal_entry SET status = 'posted' WHERE id = v_new;
  RETURN v_new;
END
$$;

DROP TRIGGER analytics_complete ON app.journal_entry;
DROP FUNCTION app.check_entry_analytics();
DROP TRIGGER guard_analytics ON app.journal_line;
DROP FUNCTION app.guard_journal_line_analytics();
ALTER TABLE app.journal_line
  DROP COLUMN counterparty_id,
  DROP COLUMN document_number,
  DROP COLUMN document_date,
  DROP COLUMN cost_object_id;
ALTER TABLE app.account
  DROP COLUMN needs_counterparty,
  DROP COLUMN needs_document,
  DROP COLUMN needs_cost_object;
DROP TABLE app.cost_object;
DROP TABLE app.counterparty;

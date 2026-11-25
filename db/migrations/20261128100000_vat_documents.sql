-- migrate:up

-- ============================================================================
-- VAT documents (docs/phase3-plan.md steps 3–4, ADR-0018): purchase and sale invoices,
-- debit and credit notes, and the accounts they post to. No rate is stored here: a line
-- names its legal_parameter key and, when the document is posted, the database checks
-- that the rate of the line is the one valid on the tax event date. Without a verified
-- parameter nothing can be posted (PROMPT.md 3.1). The ledgers, the return and the NAP
-- files come with NAP's official description (steps 6–9).
-- ============================================================================

-- Which accounts the documents post to (the chart is data: no numbers in the code).
CREATE TABLE app.vat_setting (
  office_id              uuid NOT NULL,
  company_id             uuid NOT NULL,
  input_vat_account_id   uuid,
  output_vat_account_id  uuid,
  supplier_account_id    uuid,
  customer_account_id    uuid,
  PRIMARY KEY (company_id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, input_vat_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, output_vat_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, supplier_account_id) REFERENCES app.account (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, customer_account_id) REFERENCES app.account (office_id, company_id, id)
);

CREATE TABLE app.vat_document (
  office_id       uuid NOT NULL,
  company_id      uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  direction       text NOT NULL CHECK (direction IN ('purchase', 'sale')),
  kind            text NOT NULL CHECK (kind IN ('invoice', 'debit_note', 'credit_note')),
  number          text NOT NULL CHECK (length(trim(number)) BETWEEN 1 AND 50),
  issue_date      date NOT NULL,
  tax_event_date  date NOT NULL,
  counterparty_id uuid NOT NULL,
  -- The invoice a debit or credit note corrects.
  related_id      uuid,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  entry_id        uuid UNIQUE,
  created_by      uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (office_id, company_id, counterparty_id) REFERENCES app.counterparty (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, related_id) REFERENCES app.vat_document (office_id, company_id, id),
  FOREIGN KEY (office_id, company_id, entry_id) REFERENCES app.journal_entry (office_id, company_id, id),
  CHECK ((status = 'posted') = (entry_id IS NOT NULL)),
  CHECK (kind = 'invoice' OR related_id IS NOT NULL)
);
-- The same supplier does not issue the same number twice; neither does the company.
CREATE UNIQUE INDEX vat_document_number_key
  ON app.vat_document (company_id, direction, counterparty_id, number)
  WHERE direction = 'purchase';
CREATE UNIQUE INDEX vat_document_sale_number_key
  ON app.vat_document (company_id, direction, number)
  WHERE direction = 'sale';
CREATE INDEX vat_document_tax_date_idx ON app.vat_document (company_id, tax_event_date);

CREATE TABLE app.vat_document_line (
  office_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  document_id  uuid NOT NULL,
  line_no      integer NOT NULL CHECK (line_no > 0),
  account_id   uuid NOT NULL,
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  net_amount   numeric(19, 2) NOT NULL CHECK (net_amount > 0),
  rate_key     text NOT NULL CHECK (rate_key ~ '^vat_rate_[a-z0-9_]+$'),
  rate_percent numeric(9, 4) NOT NULL CHECK (rate_percent >= 0),
  vat_amount   numeric(19, 2) NOT NULL CHECK (vat_amount >= 0),
  PRIMARY KEY (document_id, line_no),
  FOREIGN KEY (office_id, company_id, document_id)
    REFERENCES app.vat_document (office_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (office_id, company_id, account_id) REFERENCES app.account (office_id, company_id, id)
);

-- A posted document and its lines never change (a correction is a debit or credit note,
-- or the reversal of its entry). On posting, every line's rate must be the legal one.
CREATE FUNCTION app.guard_vat_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  bad record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Осчетоводен документ не се изтрива.' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Осчетоводен документ не се променя. Коригира се с известие или сторно.'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'posted' THEN
    SELECT l.line_no, l.rate_key, l.rate_percent, app.legal_numeric(l.rate_key, NEW.tax_event_date) AS legal
      INTO bad
      FROM app.vat_document_line l
     WHERE l.document_id = NEW.id
       AND app.legal_numeric(l.rate_key, NEW.tax_event_date) IS DISTINCT FROM l.rate_percent
     ORDER BY l.line_no LIMIT 1;
    IF FOUND THEN
      IF bad.legal IS NULL THEN
        RAISE EXCEPTION 'Ред %: няма проверена ставка „%“ към %. Ставките се въвеждат от официален източник.',
          bad.line_no, bad.rate_key, to_char(NEW.tax_event_date, 'DD.MM.YYYY') USING ERRCODE = '23514';
      END IF;
      RAISE EXCEPTION 'Ред %: ставката към % е %, а не %.', bad.line_no,
        to_char(NEW.tax_event_date, 'DD.MM.YYYY'), bad.legal, bad.rate_percent USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.vat_document_line WHERE document_id = NEW.id) THEN
      RAISE EXCEPTION 'Документът няма редове.' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON app.vat_document
  FOR EACH ROW EXECUTE FUNCTION app.guard_vat_document();

CREATE FUNCTION app.guard_vat_document_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM app.vat_document
   WHERE id = CASE TG_OP WHEN 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  IF v_status = 'posted' THEN
    RAISE EXCEPTION 'Осчетоводен документ не се променя. Коригира се с известие или сторно.'
      USING ERRCODE = '23514';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER guard BEFORE INSERT OR UPDATE OR DELETE ON app.vat_document_line
  FOR EACH ROW EXECUTE FUNCTION app.guard_vat_document_line();

ALTER TABLE app.vat_setting       ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.vat_document      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.vat_document_line ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY vat_setting_select ON app.vat_setting FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY vat_setting_write ON app.vat_setting FOR ALL TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_manage_chart()))
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_manage_chart()));

CREATE POLICY vat_document_select ON app.vat_document FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY vat_document_write ON app.vat_document FOR ALL TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_post_accounting()))
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_post_accounting()));

CREATE POLICY vat_document_line_select ON app.vat_document_line FOR SELECT TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_view_accounting()));
CREATE POLICY vat_document_line_write ON app.vat_document_line FOR ALL TO app_user
  USING (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
         AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
         AND (SELECT app.can_post_accounting()))
  WITH CHECK (office_id = (SELECT app.current_office_id()) AND company_id = (SELECT app.current_company_id())
              AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id()))
              AND (SELECT app.can_post_accounting()));

GRANT SELECT, INSERT, UPDATE ON app.vat_setting TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.vat_document, app.vat_document_line TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.vat_setting
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.vat_document
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.vat_document_line
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

DROP TABLE app.vat_document_line;
DROP TABLE app.vat_document;
DROP TABLE app.vat_setting;
DROP FUNCTION app.guard_vat_document_line();
DROP FUNCTION app.guard_vat_document();

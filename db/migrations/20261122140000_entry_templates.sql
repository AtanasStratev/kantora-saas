-- migrate:up

-- ============================================================================
-- Entry templates (docs/phase2-plan.md step 6): a named set of lines (account, side,
-- optional amount, memo) that fills the entry grid. A template never posts anything by
-- itself; the entry made from it goes through the same checks as any other entry.
-- Per company, because accounts are per company.
-- ============================================================================

CREATE TABLE app.entry_template (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  created_by  uuid NOT NULL DEFAULT app.current_user_id() REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  UNIQUE (company_id, name),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.entry_template_line (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  template_id uuid NOT NULL,
  line_no     integer NOT NULL CHECK (line_no >= 1),
  account_id  uuid NOT NULL,
  side        app.entry_side NOT NULL,
  -- Optional: a template may carry fixed amounts (rent) or leave them to be typed.
  amount      numeric(19, 2) CHECK (amount IS NULL OR amount > 0),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  PRIMARY KEY (template_id, line_no),
  FOREIGN KEY (office_id, company_id, template_id)
    REFERENCES app.entry_template (office_id, company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (office_id, company_id, account_id)
    REFERENCES app.account (office_id, company_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.entry_template      ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.entry_template_line ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

CREATE POLICY template_select ON app.entry_template FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());
CREATE POLICY template_write ON app.entry_template FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

CREATE POLICY template_line_select ON app.entry_template_line FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());
CREATE POLICY template_line_write ON app.entry_template_line FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.entry_template, app.entry_template_line TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.entry_template
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.entry_template_line
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

DROP TABLE app.entry_template_line;
DROP TABLE app.entry_template;

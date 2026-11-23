-- migrate:up

-- ============================================================================
-- RLS performance (found by the report reconciliation tests, 2026-11-23): the planner
-- re-evaluated has_company_access() / can_*_accounting() for every row of every inner index
-- scan; 260 journal lines took 20 s. The same policies, with the functions wrapped in
-- (SELECT ...) so PostgreSQL evaluates them ONCE per query (InitPlan).
--
-- Same meaning: every rewritten policy already requires office_id = current_office_id()
-- AND company_id = current_company_id(), so for any row that can pass,
-- has_company_access(office_id, company_id) = has_company_access(current_office_id(),
-- current_company_id()). The role functions take no row values at all.
-- Policies on other tables have no per-row function calls on the hot path and stay as they are.
-- ============================================================================

ALTER POLICY account_select ON app.account
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_view_accounting()));

ALTER POLICY account_write ON app.account
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_manage_chart()))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_manage_chart()));

ALTER POLICY template_select ON app.entry_template
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_view_accounting()));

ALTER POLICY template_write ON app.entry_template
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()));

ALTER POLICY template_line_select ON app.entry_template_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_view_accounting()));

ALTER POLICY template_line_write ON app.entry_template_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()));

ALTER POLICY fiscal_year_rw ON app.fiscal_year
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND ((SELECT app.current_office_role()) = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])));

ALTER POLICY entry_select ON app.journal_entry
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_view_accounting()));

ALTER POLICY entry_write ON app.journal_entry
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()));

ALTER POLICY line_select ON app.journal_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_view_accounting()));

ALTER POLICY line_write ON app.journal_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND (SELECT app.can_post_accounting()));

ALTER POLICY period_select ON app.period
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())));

ALTER POLICY period_write ON app.period
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND ((SELECT app.current_office_role()) = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND (SELECT app.has_company_access(app.current_office_id(), app.current_company_id())) AND ((SELECT app.current_office_role()) = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])));

-- migrate:down

ALTER POLICY account_select ON app.account
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());

ALTER POLICY account_write ON app.account
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_manage_chart())
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_manage_chart());

ALTER POLICY template_select ON app.entry_template
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());

ALTER POLICY template_write ON app.entry_template
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

ALTER POLICY template_line_select ON app.entry_template_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());

ALTER POLICY template_line_write ON app.entry_template_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

ALTER POLICY fiscal_year_rw ON app.fiscal_year
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND (app.current_office_role() = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])));

ALTER POLICY entry_select ON app.journal_entry
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());

ALTER POLICY entry_write ON app.journal_entry
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

ALTER POLICY line_select ON app.journal_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_view_accounting());

ALTER POLICY line_write ON app.journal_line
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting())
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND app.can_post_accounting());

ALTER POLICY period_select ON app.period
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id));

ALTER POLICY period_write ON app.period
  USING ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND (app.current_office_role() = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])))
  WITH CHECK ((office_id = app.current_office_id()) AND (company_id = app.current_company_id()) AND app.has_company_access(office_id, company_id) AND (app.current_office_role() = ANY (ARRAY['owner'::app.office_role, 'chief_accountant'::app.office_role])));

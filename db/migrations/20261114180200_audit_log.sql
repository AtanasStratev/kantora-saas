-- migrate:up

-- ============================================================================
-- Append-only audit log with a per-office hash chain (ADR-0008).
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app.audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  office_id   uuid,
  company_id  uuid,
  user_id     uuid,
  actor       text NOT NULL,            -- 'user' | 'system:<job>'
  ip          inet,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  table_name  text NOT NULL,
  row_pk      jsonb NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_values  jsonb,
  new_values  jsonb,
  prev_hash   bytea,
  hash        bytea NOT NULL
);
CREATE INDEX audit_log_office_idx ON app.audit_log (office_id, id);
CREATE INDEX audit_log_row_idx ON app.audit_log (table_name, row_pk);

-- Nobody may change or delete audit rows — not even the table owner.
CREATE FUNCTION app.audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Одитният журнал не може да се променя или изтрива.' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON app.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_immutable();

-- Generic row-change trigger. Runs as the function owner so app_user needs no rights
-- on audit_log. Requires an actor: app.user_id, or app.system_actor for background jobs.
CREATE FUNCTION app.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_row jsonb := coalesce(v_new, v_old);
  v_office uuid;
  v_company uuid;
  v_user uuid := app.current_user_id();
  v_system text := nullif(current_setting('app.system_actor', true), '');
  v_actor text;
  v_pk jsonb;
  v_prev bytea;
  v_changed_old jsonb;
  v_changed_new jsonb;
  k text;
BEGIN
  IF v_user IS NULL AND v_system IS NULL THEN
    RAISE EXCEPTION 'Промяна без известен потребител или системна задача не е разрешена (одитен журнал).'
      USING ERRCODE = '42501';
  END IF;
  v_actor := CASE WHEN v_user IS NOT NULL THEN 'user' ELSE 'system:' || v_system END;

  -- office/company id: the table's own columns, or the row id for app.office itself.
  v_office := CASE WHEN TG_TABLE_NAME = 'office' THEN (v_row->>'id')::uuid
                   ELSE (v_row->>'office_id')::uuid END;
  v_company := CASE WHEN TG_TABLE_NAME = 'company' THEN (v_row->>'id')::uuid
                    ELSE (v_row->>'company_id')::uuid END;

  v_pk := CASE
    WHEN v_row ? 'id' THEN jsonb_build_object('id', v_row->'id')
    ELSE jsonb_strip_nulls(jsonb_build_object(
      'office_id', v_row->'office_id', 'user_id', v_row->'user_id', 'company_id', v_row->'company_id'))
  END;

  -- Store only changed fields on UPDATE.
  IF TG_OP = 'UPDATE' THEN
    v_changed_old := '{}'::jsonb; v_changed_new := '{}'::jsonb;
    FOR k IN SELECT jsonb_object_keys(v_new) LOOP
      IF v_new->k IS DISTINCT FROM v_old->k THEN
        v_changed_old := v_changed_old || jsonb_build_object(k, v_old->k);
        v_changed_new := v_changed_new || jsonb_build_object(k, v_new->k);
      END IF;
    END LOOP;
    IF v_changed_new = '{}'::jsonb THEN
      RETURN NULL; -- no-op update, nothing to log
    END IF;
    v_old := v_changed_old; v_new := v_changed_new;
  END IF;

  -- Serialize per office so the hash chain has no forks.
  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(v_office::text, 'global'), 0));
  SELECT a.hash INTO v_prev FROM app.audit_log a
   WHERE a.office_id IS NOT DISTINCT FROM v_office ORDER BY a.id DESC LIMIT 1;

  INSERT INTO app.audit_log (office_id, company_id, user_id, actor, ip, table_name, row_pk,
                             action, old_values, new_values, prev_hash, hash)
  VALUES (v_office, v_company, v_user, v_actor, app.current_ip(), TG_TABLE_NAME, v_pk,
          TG_OP, v_old, v_new, v_prev,
          digest(coalesce(v_prev, ''::bytea) || convert_to(
            concat_ws('|', v_office, v_company, v_user, v_actor, TG_TABLE_NAME, v_pk::text,
                      TG_OP, v_old::text, v_new::text), 'UTF8'), 'sha256'));
  RETURN NULL;
END
$$;

-- Attach to every business table created so far.
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.office
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.office_membership
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.company
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.company_access
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.fiscal_year
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.period
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.legal_parameter
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- Reading: only the office owner, only their office.
ALTER TABLE app.audit_log ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON app.audit_log FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND app.current_office_role() = 'owner');
GRANT SELECT ON app.audit_log TO app_user;

-- Verifies the hash chain of one office; returns the first broken id or NULL if intact.
CREATE FUNCTION app.verify_audit_chain(p_office_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  r record;
  v_prev bytea := NULL;
BEGIN
  FOR r IN SELECT * FROM app.audit_log WHERE office_id IS NOT DISTINCT FROM p_office_id ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash <> digest(coalesce(v_prev, ''::bytea) || convert_to(
         concat_ws('|', r.office_id, r.company_id, r.user_id, r.actor, r.table_name, r.row_pk::text,
                   r.action, r.old_values::text, r.new_values::text), 'UTF8'), 'sha256') THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.verify_audit_chain(uuid) FROM PUBLIC;

-- migrate:down

DROP FUNCTION app.verify_audit_chain(uuid);
DROP TRIGGER audit ON app.legal_parameter;
DROP TRIGGER audit ON app.period;
DROP TRIGGER audit ON app.fiscal_year;
DROP TRIGGER audit ON app.company_access;
DROP TRIGGER audit ON app.company;
DROP TRIGGER audit ON app.office_membership;
DROP TRIGGER audit ON app.users;
DROP TRIGGER audit ON app.office;
DROP FUNCTION app.audit_row();
DROP TABLE app.audit_log;
DROP FUNCTION app.audit_log_immutable();

-- migrate:up

-- Fix: pgcrypto's digest() lives in schema public, which the SECURITY DEFINER audit
-- functions exclude from their pinned search_path. Use PostgreSQL's built-in sha256(bytea).
-- Hash input is byte-identical, so existing chains stay valid.

CREATE OR REPLACE FUNCTION app.audit_row() RETURNS trigger
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
          sha256(coalesce(v_prev, ''::bytea) || convert_to(
            concat_ws('|', v_office, v_company, v_user, v_actor, TG_TABLE_NAME, v_pk::text,
                      TG_OP, v_old::text, v_new::text), 'UTF8')));
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION app.verify_audit_chain(p_office_id uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  r record;
  v_prev bytea := NULL;
BEGIN
  FOR r IN SELECT * FROM app.audit_log WHERE office_id IS NOT DISTINCT FROM p_office_id ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM v_prev OR r.hash <> sha256(coalesce(v_prev, ''::bytea) || convert_to(
         concat_ws('|', r.office_id, r.company_id, r.user_id, r.actor, r.table_name, r.row_pk::text,
                   r.action, r.old_values::text, r.new_values::text), 'UTF8')) THEN
      RETURN r.id;
    END IF;
    v_prev := r.hash;
  END LOOP;
  RETURN NULL;
END
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION app.audit_row() RETURNS trigger
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
CREATE OR REPLACE FUNCTION app.verify_audit_chain(p_office_id uuid) RETURNS bigint
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

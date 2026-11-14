-- migrate:up

-- Application role (ADR-0002): not the table owner, no BYPASSRLS. Login users are granted
-- membership in it (dev: see db/dev/create_app_login.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO app_user;

-- Tenant context. Values are set ONLY with SET LOCAL inside a transaction (withTenant).
-- Missing/empty settings resolve to NULL, so policies match nothing.
CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_office_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.office_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_ip() RETURNS inet
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.ip', true), '')::inet
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO app_user;

-- migrate:down

DROP SCHEMA app CASCADE;
-- The role is cluster-wide and may own grants in other databases; drop it only if unused.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'DROP ROLE app_user';
  END IF;
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'app_user still has dependencies; not dropped';
END
$$;

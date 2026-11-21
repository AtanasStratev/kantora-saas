-- migrate:up

-- Authentication data lives in its own schema, owned by the migrator and used by the
-- auth_service role (ADR-0005). app_user gets NO access here, and auth_service gets NO
-- access to business data in schema app.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_service') THEN
    CREATE ROLE auth_service NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_service;

-- migrate:down

DROP SCHEMA auth CASCADE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_service') THEN
    EXECUTE 'DROP ROLE auth_service';
  END IF;
EXCEPTION WHEN dependent_objects_still_exist THEN
  RAISE NOTICE 'auth_service still has dependencies; not dropped';
END
$$;

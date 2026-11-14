-- migrate:up

-- ============================================================================
-- Core tenancy tables (Phase 1): office, users, membership, company, access,
-- fiscal year, period, legal parameters. RLS on every table (ADR-0002).
-- ============================================================================

CREATE TYPE app.office_role AS ENUM ('owner', 'chief_accountant', 'accountant', 'payroll', 'read_only');
CREATE TYPE app.reporting_framework AS ENUM ('nas', 'ifrs');
CREATE TYPE app.ledger_currency AS ENUM ('BGN', 'EUR');

CREATE TABLE app.office (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  eik         text,
  subscription_status text NOT NULL DEFAULT 'trial'
              CHECK (subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
  subscription_until date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Global users (one person may belong to several offices). Auth secrets live in a
-- separate schema added with the auth step (ADR-0005), never here.
CREATE TABLE app.users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  full_name   text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON app.users (lower(email));

CREATE TABLE app.office_membership (
  office_id   uuid NOT NULL REFERENCES app.office (id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  role        app.office_role NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, user_id)
);
CREATE INDEX office_membership_user_idx ON app.office_membership (user_id);

CREATE TABLE app.company (
  office_id   uuid NOT NULL REFERENCES app.office (id) ON DELETE RESTRICT,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  eik         text,
  vat_number  text,
  legal_form  text,
  reporting_framework app.reporting_framework NOT NULL DEFAULT 'nas',
  is_vat_registered boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (office_id, id)
);

CREATE TABLE app.company_access (
  office_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  company_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (office_id, user_id, company_id),
  FOREIGN KEY (office_id, user_id) REFERENCES app.office_membership (office_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE CASCADE
);
CREATE INDEX company_access_user_idx ON app.company_access (user_id, office_id);

CREATE TABLE app.fiscal_year (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  year        int  NOT NULL CHECK (year BETWEEN 1990 AND 2200),
  start_date  date NOT NULL,
  end_date    date NOT NULL CHECK (end_date > start_date),
  -- BGN for years up to 2025, EUR from 2026 (ADR-0004). Enforced below.
  ledger_currency app.ledger_currency NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  UNIQUE (company_id, year),
  FOREIGN KEY (office_id, company_id) REFERENCES app.company (office_id, id) ON DELETE RESTRICT,
  CONSTRAINT fiscal_year_currency_by_era CHECK (
    (year <= 2025 AND ledger_currency = 'BGN') OR (year >= 2026 AND ledger_currency = 'EUR')
  )
);

CREATE TABLE app.period (
  office_id   uuid NOT NULL,
  company_id  uuid NOT NULL,
  fiscal_year_id uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  month       int  NOT NULL CHECK (month BETWEEN 1 AND 12),
  start_date  date NOT NULL,
  end_date    date NOT NULL CHECK (end_date >= start_date),
  locked_at   timestamptz,
  locked_by   uuid REFERENCES app.users (id),
  PRIMARY KEY (id),
  UNIQUE (office_id, company_id, id),
  UNIQUE (fiscal_year_id, month),
  FOREIGN KEY (office_id, company_id, fiscal_year_id)
    REFERENCES app.fiscal_year (office_id, company_id, id) ON DELETE RESTRICT,
  CHECK ((locked_at IS NULL) = (locked_by IS NULL))
);

-- Legal parameters with validity dates (PROMPT.md 3.1). Global, read-only for app_user.
CREATE TABLE app.legal_parameter (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  value_numeric numeric(19, 10),
  value_json  jsonb,
  valid_from  date NOT NULL,
  valid_to    date,
  source_url  text NOT NULL,
  source_ref  text NOT NULL,
  verified_at date NOT NULL,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((value_numeric IS NULL) <> (value_json IS NULL))
);
-- No two versions of the same parameter may overlap in time.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE app.legal_parameter ADD CONSTRAINT legal_parameter_no_overlap
  EXCLUDE USING gist (key WITH =, daterange(valid_from, valid_to, '[]') WITH &&);

-- ---------------------------------------------------------------------------
-- Helper functions for policies. SECURITY DEFINER so they read membership/access
-- without recursive RLS; search_path pinned to avoid hijacking.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.current_office_role() RETURNS app.office_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT m.role FROM app.office_membership m
  WHERE m.office_id = app.current_office_id() AND m.user_id = app.current_user_id()
$$;

CREATE FUNCTION app.has_company_access(p_office_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.company_access a
    WHERE a.office_id = p_office_id
      AND a.company_id = p_company_id
      AND a.user_id = app.current_user_id()
      AND a.office_id = app.current_office_id()
  )
$$;

CREATE FUNCTION app.shares_current_office(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.office_membership m
    WHERE m.user_id = p_user_id AND m.office_id = app.current_office_id()
  ) AND app.current_office_role() IS NOT NULL
$$;

-- Creates a company and grants the creator access atomically (RLS on company requires
-- access for SELECT, so a plain INSERT ... RETURNING could not see the new row).
CREATE FUNCTION app.create_company(p_name text, p_eik text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_role app.office_role := app.current_office_role();
  v_id uuid;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('owner', 'chief_accountant') THEN
    RAISE EXCEPTION 'Нямате право да създавате фирми в тази кантора.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.company (office_id, name, eik)
  VALUES (app.current_office_id(), p_name, p_eik)
  RETURNING id INTO v_id;
  INSERT INTO app.company_access (office_id, user_id, company_id)
  VALUES (app.current_office_id(), app.current_user_id(), v_id);
  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION app.create_company(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_office_role(), app.has_company_access(uuid, uuid),
  app.shares_current_office(uuid), app.create_company(text, text) TO app_user;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE app.office            ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.users             ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.office_membership ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.company           ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.company_access    ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.fiscal_year       ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.period            ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
ALTER TABLE app.legal_parameter   ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;

-- office: members see their current office; only the owner may rename it.
CREATE POLICY office_select ON app.office FOR SELECT TO app_user
  USING (id = app.current_office_id() AND app.current_office_role() IS NOT NULL);
CREATE POLICY office_update ON app.office FOR UPDATE TO app_user
  USING (id = app.current_office_id() AND app.current_office_role() = 'owner')
  WITH CHECK (id = app.current_office_id());

-- users: yourself, plus colleagues in the current office.
CREATE POLICY users_select ON app.users FOR SELECT TO app_user
  USING (id = app.current_user_id() OR app.shares_current_office(id));
CREATE POLICY users_update_self ON app.users FOR UPDATE TO app_user
  USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());

-- membership: visible inside the current office; managed by the owner only.
CREATE POLICY membership_select ON app.office_membership FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND app.current_office_role() IS NOT NULL);
CREATE POLICY membership_write ON app.office_membership FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND app.current_office_role() = 'owner')
  WITH CHECK (office_id = app.current_office_id() AND app.current_office_role() = 'owner');

-- company: only companies the user was granted access to (create via app.create_company).
CREATE POLICY company_select ON app.company FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND app.has_company_access(office_id, id));
CREATE POLICY company_update ON app.company FOR UPDATE TO app_user
  USING (office_id = app.current_office_id() AND app.has_company_access(office_id, id)
         AND app.current_office_role() IN ('owner', 'chief_accountant'))
  WITH CHECK (office_id = app.current_office_id());

-- company_access: own rows visible; the owner sees and manages all in the office.
CREATE POLICY access_select ON app.company_access FOR SELECT TO app_user
  USING (office_id = app.current_office_id()
         AND (user_id = app.current_user_id() OR app.current_office_role() = 'owner'));
CREATE POLICY access_write ON app.company_access FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND app.current_office_role() = 'owner')
  WITH CHECK (office_id = app.current_office_id() AND app.current_office_role() = 'owner');

-- Company-scoped tables: current office AND current company AND access granted.
CREATE POLICY fiscal_year_rw ON app.fiscal_year FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id))
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id)
              AND app.current_office_role() IN ('owner', 'chief_accountant'));

CREATE POLICY period_select ON app.period FOR SELECT TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id));
CREATE POLICY period_write ON app.period FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND company_id = app.current_company_id()
         AND app.has_company_access(office_id, company_id)
         AND app.current_office_role() IN ('owner', 'chief_accountant'))
  WITH CHECK (office_id = app.current_office_id() AND company_id = app.current_company_id()
              AND app.has_company_access(office_id, company_id)
              AND app.current_office_role() IN ('owner', 'chief_accountant'));

-- legal_parameter: readable by every authenticated context, never writable by app_user.
CREATE POLICY legal_parameter_select ON app.legal_parameter FOR SELECT TO app_user USING (true);

-- ---------------------------------------------------------------------------
-- Grants (RLS decides which rows; grants decide which operations at all)
-- ---------------------------------------------------------------------------
GRANT SELECT, UPDATE ON app.office TO app_user;
GRANT SELECT, UPDATE ON app.users TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.office_membership TO app_user;
GRANT SELECT, UPDATE ON app.company TO app_user;
GRANT SELECT, INSERT, DELETE ON app.company_access TO app_user;
GRANT SELECT, INSERT, UPDATE ON app.fiscal_year TO app_user;
GRANT SELECT, INSERT, UPDATE ON app.period TO app_user;
GRANT SELECT ON app.legal_parameter TO app_user;

-- migrate:down

DROP FUNCTION app.create_company(text, text);
DROP FUNCTION app.shares_current_office(uuid);
DROP FUNCTION app.has_company_access(uuid, uuid);
DROP FUNCTION app.current_office_role();
DROP TABLE app.legal_parameter;
DROP TABLE app.period;
DROP TABLE app.fiscal_year;
DROP TABLE app.company_access;
DROP TABLE app.company;
DROP TABLE app.office_membership;
DROP TABLE app.users;
DROP TABLE app.office;
DROP TYPE app.ledger_currency;
DROP TYPE app.reporting_framework;
DROP TYPE app.office_role;

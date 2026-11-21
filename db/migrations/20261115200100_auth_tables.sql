-- migrate:up

-- Better Auth 1.7 tables (core + twoFactor plugin + database rate limiting), derived from
-- getAuthTables() of the installed package with generateId: 'uuid'. Column names are the
-- camelCase field names Better Auth queries. If Better Auth or its plugins change, a new
-- migration must follow (compare with getAuthTables output).

CREATE TABLE auth."user" (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  email              text NOT NULL UNIQUE,
  "emailVerified"    boolean NOT NULL DEFAULT false,
  image              text,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "updatedAt"        timestamptz NOT NULL DEFAULT now(),
  "twoFactorEnabled" boolean DEFAULT false
);

CREATE TABLE auth.session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "expiresAt"  timestamptz NOT NULL,
  token        text NOT NULL UNIQUE,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now(),
  "ipAddress"  text,
  "userAgent"  text,
  "userId"     uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON auth.session ("userId");

CREATE TABLE auth.account (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"             text NOT NULL,
  "providerId"            text NOT NULL,
  "userId"                uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope                   text,
  password                text,
  "createdAt"             timestamptz NOT NULL DEFAULT now(),
  "updatedAt"             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_idx ON auth.account ("userId");

CREATE TABLE auth.verification (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier   text NOT NULL,
  value        text NOT NULL,
  "expiresAt"  timestamptz NOT NULL,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON auth.verification (identifier);

CREATE TABLE auth."twoFactor" (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret                    text NOT NULL,
  "backupCodes"             text NOT NULL,
  "userId"                  uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  verified                  boolean DEFAULT true,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil"             timestamptz
);
CREATE INDEX two_factor_secret_idx ON auth."twoFactor" (secret);
CREATE INDEX two_factor_user_idx ON auth."twoFactor" ("userId");

CREATE TABLE auth."rateLimit" (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text NOT NULL UNIQUE,
  count           integer NOT NULL,
  "lastRequest"   bigint NOT NULL
);

-- Default privileges from the previous migration cover these tables; be explicit anyway.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_service;

-- Links the signed-in auth user (app.user_id, set by withUser) to the business side:
-- creates app.users and a new office with that user as owner. Works only for an auth user
-- that exists and is not yet linked, so it cannot hijack or duplicate anyone.
CREATE FUNCTION app.register_office(p_office_name text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_email text;
  v_name text;
  v_office uuid;
BEGIN
  SELECT u.email, u.name INTO v_email, v_name FROM auth."user" u WHERE u.id = v_user;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Непознат потребител.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM app.users WHERE id = v_user) THEN
    RAISE EXCEPTION 'Потребителят вече е свързан с кантора.' USING ERRCODE = '42501';
  END IF;
  IF p_office_name IS NULL OR length(trim(p_office_name)) = 0 THEN
    RAISE EXCEPTION 'Въведете име на кантората.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.users (id, email, full_name) VALUES (v_user, v_email, v_name);
  INSERT INTO app.office (name) VALUES (trim(p_office_name)) RETURNING id INTO v_office;
  INSERT INTO app.office_membership (office_id, user_id, role) VALUES (v_office, v_user, 'owner');
  RETURN v_office;
END
$$;
REVOKE ALL ON FUNCTION app.register_office(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.register_office(text) TO app_user;

-- Offices of the signed-in user (app.user_id), for choosing an office before a full
-- tenant context exists.
CREATE FUNCTION app.my_offices()
RETURNS TABLE (office_id uuid, office_name text, role app.office_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT o.id, o.name, m.role
  FROM app.office_membership m JOIN app.office o ON o.id = m.office_id
  WHERE m.user_id = app.current_user_id()
  ORDER BY o.name
$$;
REVOKE ALL ON FUNCTION app.my_offices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_offices() TO app_user;

-- migrate:down

DROP FUNCTION app.my_offices();
DROP FUNCTION app.register_office(text);
DROP TABLE auth."rateLimit";
DROP TABLE auth."twoFactor";
DROP TABLE auth.verification;
DROP TABLE auth.account;
DROP TABLE auth.session;
DROP TABLE auth."user";

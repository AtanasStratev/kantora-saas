-- migrate:up

-- ============================================================================
-- Team management (PRD §2): invitations, the office always keeps an owner, and the
-- owner sees every company of the office (the owner manages company access).
-- ============================================================================

-- 1. Owner has access to every company of their office; other roles need company_access.
CREATE OR REPLACE FUNCTION app.has_company_access(p_office_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT p_office_id = app.current_office_id() AND (
    app.current_office_role() = 'owner'
    OR EXISTS (
      SELECT 1 FROM app.company_access a
      WHERE a.office_id = p_office_id
        AND a.company_id = p_company_id
        AND a.user_id = app.current_user_id()
    )
  )
$$;

-- 2. An office can never lose its last owner (demotion or removal).
CREATE FUNCTION app.keep_an_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF OLD.role = 'owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND NOT EXISTS (
       SELECT 1 FROM app.office_membership m
       WHERE m.office_id = OLD.office_id AND m.role = 'owner' AND m.user_id <> OLD.user_id
     ) THEN
    RAISE EXCEPTION 'Кантората трябва да има поне един собственик. Първо направете друг член собственик.'
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER keep_an_owner BEFORE UPDATE OF role OR DELETE ON app.office_membership
  FOR EACH ROW EXECUTE FUNCTION app.keep_an_owner();

-- 3. Invitations. Only a SHA-256 hash of the token is stored; the token itself is shown
--    once to the owner (to send) and never persisted.
CREATE TABLE app.invitation (
  office_id   uuid NOT NULL REFERENCES app.office (id) ON DELETE CASCADE,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  email       text NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role        app.office_role NOT NULL,
  token_hash  bytea NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES app.users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid REFERENCES app.users (id),
  revoked_at  timestamptz,
  PRIMARY KEY (id),
  UNIQUE (office_id, id)
);
-- One open invitation per e-mail per office.
CREATE UNIQUE INDEX invitation_open_uq ON app.invitation (office_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE app.invitation ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_owner ON app.invitation FOR ALL TO app_user
  USING (office_id = app.current_office_id() AND app.current_office_role() = 'owner')
  WITH CHECK (office_id = app.current_office_id() AND app.current_office_role() = 'owner'
              AND invited_by = app.current_user_id());
GRANT SELECT, INSERT, UPDATE ON app.invitation TO app_user;
CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.invitation
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- What an invitation link shows before signing in. Reveals nothing without the token.
CREATE FUNCTION app.invitation_preview(p_token text)
RETURNS TABLE (office_name text, email text, role app.office_role, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT o.name, i.email, i.role,
         CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked'
              WHEN i.accepted_at IS NOT NULL THEN 'accepted'
              WHEN i.expires_at < now() THEN 'expired'
              ELSE 'open' END
  FROM app.invitation i JOIN app.office o ON o.id = i.office_id
  WHERE i.token_hash = sha256(convert_to(p_token, 'UTF8'))
$$;
REVOKE ALL ON FUNCTION app.invitation_preview(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.invitation_preview(text) TO app_user;

-- Accepts an invitation for the signed-in user (app.user_id). The account e-mail must
-- match the invited e-mail; the invitation must be open. Creates app.users if needed.
CREATE FUNCTION app.accept_invitation(p_token text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_email text;
  v_name text;
  v_inv app.invitation%ROWTYPE;
BEGIN
  SELECT u.email, u.name INTO v_email, v_name FROM auth."user" u WHERE u.id = v_user;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Непознат потребител.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv FROM app.invitation
   WHERE token_hash = sha256(convert_to(p_token, 'UTF8')) FOR UPDATE;
  IF NOT FOUND OR v_inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Поканата не е валидна. Помолете собственика на кантората за нова.'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Поканата вече е използвана.' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at < now() THEN
    RAISE EXCEPTION 'Поканата е изтекла. Помолете собственика на кантората за нова.'
      USING ERRCODE = '22023';
  END IF;
  IF lower(v_inv.email) <> lower(v_email) THEN
    RAISE EXCEPTION 'Поканата е за %, а сте влезли като %. Влезте с поканения имейл.',
      v_inv.email, v_email USING ERRCODE = '42501';
  END IF;

  INSERT INTO app.users (id, email, full_name) VALUES (v_user, v_email, v_name)
  ON CONFLICT (id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM app.office_membership
             WHERE office_id = v_inv.office_id AND user_id = v_user) THEN
    RAISE EXCEPTION 'Вече сте член на тази кантора.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.office_membership (office_id, user_id, role)
  VALUES (v_inv.office_id, v_user, v_inv.role);
  UPDATE app.invitation SET accepted_at = now(), accepted_by = v_user WHERE id = v_inv.id;
  RETURN v_inv.office_id;
END
$$;
REVOKE ALL ON FUNCTION app.accept_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text) TO app_user;

-- migrate:down

DROP FUNCTION app.accept_invitation(text);
DROP FUNCTION app.invitation_preview(text);
DROP TABLE app.invitation;
DROP TRIGGER keep_an_owner ON app.office_membership;
DROP FUNCTION app.keep_an_owner();
CREATE OR REPLACE FUNCTION app.has_company_access(p_office_id uuid, p_company_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.company_access a
    WHERE a.office_id = p_office_id
      AND a.company_id = p_company_id
      AND a.user_id = app.current_user_id()
      AND a.office_id = app.current_office_id()
  )
$$;

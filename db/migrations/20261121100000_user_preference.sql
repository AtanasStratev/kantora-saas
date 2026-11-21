-- migrate:up

-- Per-user UI preferences (PROMPT.md 5.1: the theme is remembered for the user).
CREATE TYPE app.ui_theme AS ENUM ('system', 'light', 'dark', 'black');

CREATE TABLE app.user_preference (
  user_id    uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  theme      app.ui_theme NOT NULL DEFAULT 'system',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.user_preference ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
CREATE POLICY user_preference_own ON app.user_preference FOR ALL TO app_user
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
GRANT SELECT, INSERT, UPDATE ON app.user_preference TO app_user;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON app.user_preference
  FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- migrate:down

DROP TABLE app.user_preference;
DROP TYPE app.ui_theme;

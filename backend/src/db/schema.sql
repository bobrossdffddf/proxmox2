-- ---------------------------------------------------------------------------
-- WCTARange schema. Applied automatically on backend startup if the tables
-- don't exist. Safe to re-run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'student',
  -- 'student' | 'admin'
  disabled      BOOLEAN NOT NULL DEFAULT FALSE,
  max_vms             INT NOT NULL DEFAULT 1,
  allowed_templates   TEXT NOT NULL DEFAULT '*',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  BIGSERIAL PRIMARY KEY,
  public_id           VARCHAR(32) UNIQUE NOT NULL,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id         VARCHAR(64) NOT NULL,
  template_name       VARCHAR(128) NOT NULL,
  protocol            VARCHAR(8)  NOT NULL,
  proxmox_node        VARCHAR(64) NOT NULL,
  proxmox_vmid        INT NOT NULL,
  proxmox_template_id INT NOT NULL,
  snapshot_name       VARCHAR(64) NOT NULL,
  guest_ip            VARCHAR(64),
  guest_port          INT NOT NULL,
  guest_username      VARCHAR(128),
  guest_password      TEXT,
  status              VARCHAR(24) NOT NULL DEFAULT 'queued',
  -- 'queued' | 'provisioning' | 'running' | 'cleaning' | 'stopped' | 'failed' | 'cleanup_failed'
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hard_expires_at     TIMESTAMPTZ NOT NULL,
  cleaned_up_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx       ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx     ON sessions(status);
CREATE INDEX IF NOT EXISTS sessions_template_idx   ON sessions(template_id);
CREATE INDEX IF NOT EXISTS sessions_node_idx       ON sessions(proxmox_node);
CREATE INDEX IF NOT EXISTS sessions_activity_idx   ON sessions(last_activity_at);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_vmid_unique
  ON sessions(proxmox_vmid)
  WHERE status IN ('queued','provisioning','running','cleaning');

CREATE TABLE IF NOT EXISTS staged_vms (
  id                  BIGSERIAL PRIMARY KEY,
  template_id         VARCHAR(64) NOT NULL,
  template_name       VARCHAR(128) NOT NULL,
  protocol            VARCHAR(8)  NOT NULL,
  proxmox_node        VARCHAR(64) NOT NULL,
  proxmox_vmid        INT NOT NULL UNIQUE,
  proxmox_template_id INT NOT NULL,
  snapshot_name       VARCHAR(64) NOT NULL,
  guest_ip            VARCHAR(64),
  guest_port          INT NOT NULL,
  guest_username      VARCHAR(128),
  guest_password      TEXT,
  status              VARCHAR(24) NOT NULL DEFAULT 'queued',
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staged_template_idx ON staged_vms(template_id);
CREATE INDEX IF NOT EXISTS staged_status_idx ON staged_vms(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  username    VARCHAR(64),
  action      VARCHAR(64) NOT NULL,
  session_id  BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  ip_address  VARCHAR(64),
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_user_idx    ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS announcements (
  id          BIGSERIAL PRIMARY KEY,
  title       VARCHAR(120) NOT NULL,
  message     TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS announcements_active_created_idx ON announcements(active, created_at DESC);

-- Backfill migrations for existing deployments

ALTER TABLE users ADD COLUMN IF NOT EXISTS max_vms INT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_templates TEXT NOT NULL DEFAULT '*';

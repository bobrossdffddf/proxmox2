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

CREATE TABLE IF NOT EXISTS template_staging_settings (
  template_id VARCHAR(64) PRIMARY KEY,
  pool_size   INT NOT NULL DEFAULT 1 CHECK (pool_size >= 0 AND pool_size <= 20),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- VM imports. One row per uploaded VMware/OVA bundle, from the moment the
-- upload starts until the template exists (or the run fails). `inspection`
-- holds what we read out of the bundle, `settings` what the admin confirmed.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vm_imports (
  id                BIGSERIAL PRIMARY KEY,
  public_id         VARCHAR(32) UNIQUE NOT NULL,
  original_filename TEXT NOT NULL,
  upload_path       TEXT,
  upload_bytes      BIGINT NOT NULL DEFAULT 0,
  status            VARCHAR(16) NOT NULL DEFAULT 'inspecting',
  -- 'inspecting' | 'ready' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  stage             VARCHAR(16) NOT NULL DEFAULT 'upload',
  progress          INT NOT NULL DEFAULT 0,
  inspection        JSONB,
  settings          JSONB,
  result            JSONB,
  error             TEXT,
  created_by        INT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS vm_imports_status_idx  ON vm_imports(status);
CREATE INDEX IF NOT EXISTS vm_imports_created_idx ON vm_imports(created_at DESC);

CREATE TABLE IF NOT EXISTS vm_import_log (
  id         BIGSERIAL PRIMARY KEY,
  import_id  BIGINT NOT NULL REFERENCES vm_imports(id) ON DELETE CASCADE,
  level      VARCHAR(8) NOT NULL DEFAULT 'info',
  -- 'info' | 'warn' | 'error'
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vm_import_log_import_idx ON vm_import_log(import_id, id);

-- ---------------------------------------------------------------------------
-- Templates registered by the import wizard. Same shape as a templates.yaml
-- entry; kept here so the config mount stays read-only and a new tile shows up
-- without a container restart. YAML entries win on an id collision.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS imported_templates (
  id                  VARCHAR(64) PRIMARY KEY,
  name                VARCHAR(128) NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  icon                VARCHAR(16) NOT NULL DEFAULT 'generic',
  proxmox_template_id INT NOT NULL,
  proxmox_template_ids JSONB,
  snapshot_name       VARCHAR(64) NOT NULL DEFAULT '',
  protocol            VARCHAR(8) NOT NULL,
  port                INT NOT NULL,
  username            VARCHAR(128) NOT NULL,
  password            TEXT NOT NULL,
  cpu_cores           INT NOT NULL,
  memory_mb           INT NOT NULL,
  staging_pool_size   INT NOT NULL DEFAULT 1,
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  color               VARCHAR(16),
  source_import_id    BIGINT REFERENCES vm_imports(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill migrations for existing deployments

ALTER TABLE users ADD COLUMN IF NOT EXISTS max_vms INT NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_templates TEXT NOT NULL DEFAULT '*';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS extended_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS notes TEXT;

-- ---------------------------------------------------------------------------
-- Demo mode. An admin can flip one of their own running sessions into a live
-- demo; every signed-in user then gets a read-only spectator link to it.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS demo_active     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS demo_title      VARCHAR(120);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS demo_started_at TIMESTAMPTZ;

-- Only one demo can be live at a time.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_demo_unique
  ON sessions((demo_active))
  WHERE demo_active;

-- ---------------------------------------------------------------------------
-- Staging health. A template whose warm pool cannot be filled used to show
-- "Warming up" on the tile forever with the reason buried in the backend log.
-- We record the last staging outcome per template so the tile, and the admin
-- staging tab, can say what actually went wrong.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS template_staging_health (
  template_id          VARCHAR(64) PRIMARY KEY,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_error_at        TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Template visibility overrides.
--
-- A template defined in templates.yaml cannot be deleted from the admin UI —
-- the config mount is read-only and the file is the source of truth. Hiding it
-- here lets an admin retire a broken image without shell access, and the row
-- is removed again if the YAML entry ever goes away.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS template_overrides (
  template_id VARCHAR(64) PRIMARY KEY,
  hidden      BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_at   TIMESTAMPTZ,
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

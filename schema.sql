PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'xiaohongshu',
  handle TEXT NOT NULL,
  phone_country_code TEXT NOT NULL DEFAULT '+86',
  phone_number TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'verification_needed', 'disabled')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (platform, handle)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_accounts_phone
  ON work_accounts(platform, phone_country_code, phone_number);

CREATE TABLE IF NOT EXISTS device_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  device_count INTEGER NOT NULL DEFAULT 0,
  adb_version TEXT NOT NULL DEFAULT '',
  appium_status TEXT NOT NULL DEFAULT 'not_configured',
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manufacturer TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  os_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'maintenance', 'disabled')),
  connection_status TEXT NOT NULL DEFAULT 'unpaired'
    CHECK (connection_status IN ('unpaired', 'online', 'offline', 'attention')),
  agent_name TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  battery_percent INTEGER CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100),
  screen_resolution TEXT NOT NULL DEFAULT '',
  device_ref TEXT,
  connector_id TEXT REFERENCES device_connectors(id),
  connection_type TEXT NOT NULL DEFAULT '',
  adb_address TEXT NOT NULL DEFAULT '',
  adb_state TEXT NOT NULL DEFAULT '',
  charging INTEGER,
  sdk_version TEXT NOT NULL DEFAULT '',
  collected_at TEXT,
  collection_error TEXT NOT NULL DEFAULT '',
  connection_mode TEXT NOT NULL DEFAULT 'active' CHECK (connection_mode IN ('active', 'paused')),
  control_revision INTEGER NOT NULL DEFAULT 0,
  control_ack_revision INTEGER NOT NULL DEFAULT 0,
  control_changed_at TEXT,
  control_ack_at TEXT,
  control_error TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_device_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES work_accounts(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'ended', 'verification_needed')),
  login_confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_work_accounts_status ON work_accounts(status);
CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_ref ON devices(device_ref);
CREATE INDEX IF NOT EXISTS idx_devices_connector ON devices(connector_id);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON account_device_sessions(account_id, login_confirmed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON account_device_sessions(device_id, login_confirmed_at DESC);

CREATE TABLE IF NOT EXISTS apk_installers (
  connector_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apk_packages (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  UNIQUE(connector_id, sha256)
);
CREATE TABLE IF NOT EXISTS apk_installations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  connector_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  package_id TEXT NOT NULL REFERENCES apk_packages(id),
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown')),
  lease_token TEXT,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_apk_installations_queue ON apk_installations(connector_id,status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apk_installations_device_busy ON apk_installations(device_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS note_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  note_url TEXT NOT NULL,
  expected_title TEXT NOT NULL DEFAULT '',
  expected_author TEXT NOT NULL DEFAULT '',
  actions TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_workers (
  connector_id TEXT PRIMARY KEY,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES note_tasks(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  account_id TEXT NOT NULL REFERENCES work_accounts(id),
  connector_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','unknown','cancelled')),
  lease_token TEXT,
  message TEXT NOT NULL DEFAULT '',
  resolved_note_id TEXT NOT NULL DEFAULT '',
  resolved_title TEXT NOT NULL DEFAULT '',
  resolved_author TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS task_run_actions (
  run_id TEXT NOT NULL REFERENCES task_runs(id),
  action TEXT NOT NULL CHECK(action IN ('like','collect','follow')),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','performed','skipped','unknown','not_run')),
  confirmed_at TEXT,
  PRIMARY KEY(run_id,action)
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_account ON task_runs(account_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_queue ON task_runs(connector_id,status,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_busy_device ON task_runs(device_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_busy_account ON task_runs(account_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_worker ON task_runs(connector_id) WHERE status='running';
CREATE TRIGGER IF NOT EXISTS task_runs_exclude_installation BEFORE INSERT ON task_runs
WHEN NEW.status IN ('queued','running') AND EXISTS(SELECT 1 FROM apk_installations WHERE device_id=NEW.device_id AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device has an installation'); END;
CREATE TRIGGER IF NOT EXISTS installations_exclude_task BEFORE INSERT ON apk_installations
WHEN NEW.status IN ('queued','running') AND EXISTS(SELECT 1 FROM task_runs WHERE device_id=NEW.device_id AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device has a note task'); END;

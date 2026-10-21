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

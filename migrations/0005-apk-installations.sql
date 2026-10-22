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

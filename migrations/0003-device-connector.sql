CREATE TABLE device_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  device_count INTEGER NOT NULL DEFAULT 0,
  adb_version TEXT NOT NULL DEFAULT '',
  appium_status TEXT NOT NULL DEFAULT 'not_configured',
  last_error TEXT NOT NULL DEFAULT ''
);

ALTER TABLE devices ADD COLUMN device_ref TEXT;
ALTER TABLE devices ADD COLUMN connector_id TEXT REFERENCES device_connectors(id);
ALTER TABLE devices ADD COLUMN connection_type TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN adb_address TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN adb_state TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN charging INTEGER;
ALTER TABLE devices ADD COLUMN sdk_version TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN collected_at TEXT;
ALTER TABLE devices ADD COLUMN collection_error TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_devices_ref ON devices(device_ref);
CREATE INDEX idx_devices_connector ON devices(connector_id);

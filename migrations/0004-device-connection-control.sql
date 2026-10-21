ALTER TABLE devices ADD COLUMN connection_mode TEXT NOT NULL DEFAULT 'active'
  CHECK (connection_mode IN ('active', 'paused'));
ALTER TABLE devices ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN control_ack_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN control_changed_at TEXT;
ALTER TABLE devices ADD COLUMN control_ack_at TEXT;
ALTER TABLE devices ADD COLUMN control_error TEXT NOT NULL DEFAULT '';

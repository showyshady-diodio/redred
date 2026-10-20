ALTER TABLE work_accounts ADD COLUMN phone_country_code TEXT NOT NULL DEFAULT '+86';
ALTER TABLE work_accounts ADD COLUMN phone_number TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX idx_work_accounts_phone
  ON work_accounts(platform, phone_country_code, phone_number)
  WHERE phone_number <> '';

ALTER TABLE devices ADD COLUMN manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN os_version TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'unpaired'
  CHECK (connection_status IN ('unpaired', 'online', 'offline', 'attention'));
ALTER TABLE devices ADD COLUMN agent_name TEXT NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN last_seen_at TEXT;
ALTER TABLE devices ADD COLUMN battery_percent INTEGER
  CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100);
ALTER TABLE devices ADD COLUMN screen_resolution TEXT NOT NULL DEFAULT '';

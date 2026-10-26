CREATE TABLE device_account_members (
  account_id TEXT PRIMARY KEY REFERENCES work_accounts(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  xhs_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_device_account_members_device ON device_account_members(device_id);
CREATE TRIGGER device_group_busy_update BEFORE UPDATE ON device_account_members
WHEN EXISTS(SELECT 1 FROM task_runs WHERE (device_id=OLD.device_id OR device_id=NEW.device_id OR account_id=OLD.account_id) AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device account group busy'); END;
CREATE TRIGGER device_group_busy_delete BEFORE DELETE ON device_account_members
WHEN EXISTS(SELECT 1 FROM task_runs WHERE (device_id=OLD.device_id OR account_id=OLD.account_id) AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device account group busy'); END;
CREATE TRIGGER device_group_busy_insert BEFORE INSERT ON device_account_members
WHEN EXISTS(SELECT 1 FROM task_runs WHERE (device_id=NEW.device_id OR account_id=NEW.account_id) AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device account group busy'); END;
CREATE TRIGGER task_fixed_account_guard BEFORE INSERT ON task_runs
WHEN EXISTS(SELECT 1 FROM device_account_members WHERE account_id=NEW.account_id AND (device_id<>NEW.device_id OR xhs_number<>COALESCE(json_extract(NEW.snapshot,'$.xhs_number'),'')))
BEGIN SELECT RAISE(ABORT,'device account group mismatch'); END;

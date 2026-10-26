CREATE TABLE account_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE account_login_identities (
  account_id TEXT PRIMARY KEY REFERENCES work_accounts(id),
  xhs_number TEXT NOT NULL COLLATE NOCASE UNIQUE
);
CREATE TABLE account_group_members (
  account_id TEXT PRIMARY KEY REFERENCES work_accounts(id),
  group_id TEXT NOT NULL REFERENCES account_groups(id)
);
CREATE INDEX idx_account_group_members_group ON account_group_members(group_id);
CREATE TABLE device_account_bindings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  group_id TEXT UNIQUE REFERENCES account_groups(id),
  account_id TEXT UNIQUE REFERENCES work_accounts(id),
  CHECK ((group_id IS NOT NULL AND account_id IS NULL) OR (group_id IS NULL AND account_id IS NOT NULL))
);
INSERT INTO account_groups(id,name) SELECT 'group-'||d.id,d.name||'账号组' FROM devices d WHERE EXISTS(SELECT 1 FROM device_account_members m WHERE m.device_id=d.id);
INSERT INTO account_login_identities(account_id,xhs_number) SELECT account_id,xhs_number FROM device_account_members;
INSERT INTO account_group_members(account_id,group_id) SELECT account_id,'group-'||device_id FROM device_account_members;
INSERT INTO device_account_bindings(device_id,group_id) SELECT DISTINCT device_id,'group-'||device_id FROM device_account_members;
CREATE TRIGGER account_binding_busy_insert BEFORE INSERT ON device_account_bindings
WHEN EXISTS(SELECT 1 FROM task_runs WHERE device_id=NEW.device_id AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device account group busy'); END;
CREATE TRIGGER account_binding_busy_delete BEFORE DELETE ON device_account_bindings
WHEN EXISTS(SELECT 1 FROM task_runs WHERE device_id=OLD.device_id AND status IN ('queued','running'))
BEGIN SELECT RAISE(ABORT,'device account group busy'); END;

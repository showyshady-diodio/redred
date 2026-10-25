ALTER TABLE device_connectors ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
ALTER TABLE device_connectors ADD COLUMN instance_id TEXT NOT NULL DEFAULT '';
ALTER TABLE device_connectors ADD COLUMN instance_seen_at TEXT;
CREATE TRIGGER device_owner_busy BEFORE UPDATE OF connector_id ON devices
WHEN OLD.connector_id IS NOT NEW.connector_id AND (
  EXISTS(SELECT 1 FROM task_runs WHERE device_id=OLD.id AND status IN ('queued','running')) OR
  EXISTS(SELECT 1 FROM apk_installations WHERE device_id=OLD.id AND status IN ('queued','running')))
BEGIN SELECT RAISE(ABORT,'device has pending work'); END;
CREATE TRIGGER task_runs_owner BEFORE INSERT ON task_runs
WHEN NEW.connector_id IS NOT (SELECT connector_id FROM devices WHERE id=NEW.device_id) OR NOT EXISTS(SELECT 1 FROM device_connectors WHERE id=NEW.connector_id AND enabled=1)
BEGIN SELECT RAISE(ABORT,'device owner changed'); END;
CREATE TRIGGER installations_owner BEFORE INSERT ON apk_installations
WHEN NEW.connector_id IS NOT (SELECT connector_id FROM devices WHERE id=NEW.device_id) OR NOT EXISTS(SELECT 1 FROM device_connectors WHERE id=NEW.connector_id AND enabled=1)
BEGIN SELECT RAISE(ABORT,'device owner changed'); END;

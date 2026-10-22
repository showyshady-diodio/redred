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

# Note tasks and execution ledger

The existing Pages application now has a Tasks tab. A task stores its name, original share link (or a pasted share message), optional expected author and heading/caption, selected like/collect/follow actions, and operator notes. Saving a task does not operate a phone. Each Execute submission selects one device and one work account, creating an immutable parameter snapshot in a separate execution row. The same task can have multiple executions with different device/account selections. Editing the task does not rewrite old snapshots or queued executions.

## Counting

- `execution_count` counts executions that were actually claimed and started, including failed or uncertain executions. Queued and cancelled-before-start rows do not count.
- `succeeded_count` counts executions whose requested actions were all confirmed or already satisfied.
- `like_count`, `collect_count`, and `follow_count` count only confirmed `clicked_once` outcomes from this project's task worker. Already-satisfied actions are `skipped` and add zero.
- Task and account statistics derive from the same action ledger, unique by execution and action. Replayed results do not add counts. Confirmed actions remain counted even if a later action fails.
- The counts are operations, not unique notes, unique authors, platform-wide totals, or proof that engagement persists forever. If someone manually cancels an action and a later task performs it again, that new confirmed operation counts again.
- Earlier ad hoc script tests have not been backfilled into the ledger. Uncertain actions add zero; there is no automatic retry or manual count editing.

## Dispatch and execution

The UI requires the existing device-control code for saving/editing tasks and dispatching/cancelling executions; the existing tab authorization is reused. The selected account must have an active, manually confirmed login binding on the selected phone. Choosing an account does not log in or switch accounts. Device/account availability, connectivity, binding, and installation conflicts are validated before queueing and claiming. The worker and script recheck policy during execution.

The worker executes one task at a time per connector. Each device and account can have at most one queued/running execution. Database triggers also prevent an APK installation and a note task from queueing on the same phone. Waiting jobs can be cancelled; running jobs are not blindly retried or force-cancelled. Phone pause/disable or a changed login binding stops later script actions at policy checks.

Tasks use the share link directly. They do not run the slower title-search flow. The existing script resolves the note ID and verifies native title/caption and author. Optional expected fields are checked independently; omitted values are discovered on the phone. The physical logged-in identity still relies on the operator-confirmed backend binding.

## Start the local worker

Use Node 24.14 or newer, the existing ignored `connector/connector.production.local.json`, the running telemetry connector, and the existing local Appium server. Run:

```powershell
npm run worker
```

Or run `connector/start-task-worker.ps1`. Keep the phone unlocked with its screen on. The worker polls every three seconds, heartbeats during execution, journals claimed jobs and confirmed results under ignored `connector/.state`, and writes local screenshots/reports to `work/task-runs/<execution-id>`. Neither local configuration secrets nor phone screenshots are uploaded with the website. Restarting Windows still requires restarting these local services; this change does not configure boot persistence.

Confirmed actions are atomically checkpointed to the local report after each action and periodically synchronized to the ledger. Failed result delivery is retried from the journal, without rerunning phone actions. Restart during a claimed execution reports an uncertain result using any saved confirmations. Unknown results never inflate counters. A click that succeeded on the phone but lost its confirmation can remain uncounted. An execution exceeding seven minutes is stopped and reported as uncertain. Server-side running leases expire after ten minutes without renewal; queued jobs expire after thirty minutes without execution.

## Release

Apply only `migrations/0006-note-tasks.sql` to the existing D1 database before releasing the new Functions. Do not replay older migrations. `schema.sql` includes the same additive structures for clean local setup. Publish only the directory produced by `node prepare-deploy.mjs`.

Validation: API/database tests cover authorization, active account/device binding, immutable snapshots, replay-safe partial counts, account/task totals, cancellation, APK mutual exclusion and expired leases. A local UI integration server using real in-memory SQLite verified task creation from a share message, dispatch, cancellation and matching account detail totals. Live dispatch and worker connectivity must also be checked after migration and deployment.

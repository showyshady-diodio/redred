# Shared development and temporary test computers

Use one primary computer for normal execution. The original `local-adb` connector stays the primary computer. Other computers are temporary test connectors. Work accounts, task definitions, login confirmations, execution history and action counts remain shared; this release does not add organization, user roles or data partitions.

## Collaborating on code

Clone `https://github.com/showyshady-diodio/redred.git`, or extract the clean source package produced by `node prepare-handoff.mjs`. The package includes source, tests, schema/migrations and setup documentation, but not local configuration, connector state, credentials, phone screenshots, SDK installers or node_modules. Editing the frontend/backend does not require Cloudflare login. Use a branch and submit a PR; merge/release is handled on the main computer. Do not replay old migrations against production or initialize the existing database.

## Connecting a test computer

1. In the existing website, open Devices > Execution computers > Add test computer. Enter a name, reuse the existing device control authorization, and download `connector.testing.local.json`.
2. Send the source package/repository and that computer's configuration to your collaborator. The configuration contains the shared project connector token. It does not contain a Cloudflare OAuth login, account API token or device control code. Collaborators are trusted and use the same backend; disabling a connector is operational control, not credential revocation or a security boundary.
3. Put the downloaded file in the source project's `connector` directory. Install Node.js 24.14+, Android platform-tools, JDK 17, Appium 3 and the UiAutomator2 driver on that computer. Match helper APKs to the installed driver and follow the existing manual-login/Appium instructions for phone-specific installation/input permissions. Do not copy `.state` from another computer.
4. Prepare this computer's paths:

```powershell
node connector/setup-workstation.mjs --config connector/connector.testing.local.json --adb "D:/Android/platform-tools/adb.exe"
```

5. Set that computer's `JAVA_HOME` and `ANDROID_HOME` for the Appium process, then run Appium on localhost:

```powershell
appium --address 127.0.0.1 --port 4723
```

6. In three other terminals, from the project root:

```powershell
node connector/adb-connector.mjs --config connector/connector.testing.local.json
node connector/apk-installer.mjs --config connector/connector.testing.local.json
node connector/task-worker.mjs --config connector/connector.testing.local.json
```

Each command is a long-running service. The configuration's APK catalog directory is `connector/apks`, and reports/screenshots are in `connector/work`. Those directories and `.state` are ignored by Git. The existing primary computer retains its original APK directories and report paths.

Pair the phone with that computer using Android wireless debugging (`adb pair`, then the actual connection endpoint), or authorize USB debugging. A newly discovered phone is enrolled under that computer. Phone Wi-Fi pairing and screen unlock remain phone/operator prerequisites. No Cloudflare login is required to collect telemetry, execute a task, install an APK or submit execution results.

## Moving an existing phone between computers

Finish/cancel queued jobs and finish running jobs/installations. Disconnect the old computer from that phone, pair/connect the new computer, then choose Devices > More > Transfer computer. Select the destination. The device ID, work account binding, operator notes, pause intent and execution history are preserved. The new computer must rediscover the hardware reference before the phone becomes online. The old collector ignores that phone's telemetry and cannot claim new jobs for it. If returning to normal operation, transfer the phone back to the primary computer.

Task and APK claims are scoped to the device's assigned connector. Database triggers reject an ownership transfer while queued/running work exists and reject inserting a job with a stale owner. Existing jobs are not silently rerouted. If the same connector ID is used on two computers, a local instance identity detects the conflict while the first computer is active; use a separate downloaded configuration for the second computer. A stopped instance lease expires after 90 seconds. Three services on the same computer share their instance identity automatically.

## Ending a test

Stop the collaborator's local services. Optionally click Disable connection for that test computer in the website; this stops further telemetry/claims for that connector and retains its history. Cancel/finish its existing tasks first. Other computers continue normally. Reenable it to reuse its configuration later. If the shared connector token itself must be revoked, rotate it and update every participating computer; disabling one ID does not invalidate a shared token.

## Release

Apply only `migrations/0007-shared-workstations.sql` to the existing D1 database before publishing the updated Functions. Restart the primary collector, installer and task worker so that they send the computer instance header. The primary ID/domain/account/device data remain unchanged. All participating computers must use the updated client source. The original legacy primary client is accepted only until a new instance claims its connector ID.

# MCN account management MVP

## Manual APK installation (2026-10-22)

The existing Devices page now has an Install APK action per enrolled device. See [APK-INSTALLATION.md](APK-INSTALLATION.md) for the local installer, allowed file directories, authorization, and result handling. This uses local physical Android devices, without AWS. Apply only migration 0005 to existing databases; older migrations were applied directly and must not be replayed with `migrations apply`.

Minimal Cloudflare Pages + D1 application for maintaining work-account records, device records, and operator-confirmed login history.

## Device auto-sync (2026-10-21)

Production deployment has been verified on `https://redred-1vl.pages.dev/#devices`. Migration 0003 is already applied remotely; do not reapply it. The original account is preserved, and a real Xiaomi phone has been imported and repeatedly synced into the remote database with the same device ID. The initial verified deployment was `128d6e1f.redred-1vl.pages.dev`; use the stable domain for the current production version.

For the configured workstation, keep the production connector running with:

```powershell
node connector/adb-connector.mjs --config connector/connector.production.local.json
```

The ignored production config is separate from the localhost config. It contains the production connector credential and must not be committed or uploaded. On this workstation, `wrangler login --device --browser=false` was verified to complete login without a localhost callback. Set `WRANGLER_SEND_METRICS=false` if the CLI prints its result but remains running while sending usage metrics.

The existing device manager now accepts authenticated ADB snapshots. Run the local connector on the computer connected to the phones. It discovers authorized USB/wireless devices, reads manufacturer/model, Android/SDK version, battery/charging state, resolution and connection address, and saves them to D1 every 20 seconds. The web device tab refreshes every 10 seconds, includes connection filtering, details and editing, and shows connector/Appium service status.

Identity is a SHA-256 reference derived locally from the device hardware serial. Wireless IP/port changes do not create a new record, and simultaneous USB/Wi-Fi connections are deduplicated. The raw hardware serial is not sent to D1. A failed identity read skips import and reports the error. Existing manually registered records remain separate until an explicit association is implemented; the connector does not guess which existing record belongs to a phone.

Heartbeats preserve operator names, notes, availability and account/device login records. A full successful scan marks absent devices offline; ADB scan failures send no snapshot. When the connector stops reporting, the read API presents devices as offline after 90 seconds, retaining the previous telemetry and its timestamp. No account login is inferred from an ADB connection.

Appium is optional: set `appium_url` to `http://127.0.0.1:4723` after installing Appium. Only `/status` is checked at this stage; a ready service does not mean an Appium device session has been established.

### Upgrade the existing deployment

Do not initialize or recreate the existing database. If migration 0002 has already been applied, apply only:

```powershell
node C:\Users\86188\node_modules\wrangler\bin\wrangler.js d1 execute mcn-account-management --remote --file=migrations/0003-device-connector.sql
```

Set a random secret of at least 32 characters as the Pages production secret `DEVICE_CONNECTOR_TOKEN`; the connector uses the same value through its environment variable or ignored `connector/connector.local.json` config (`token`). `DEVICE_CONNECTOR_ID` defaults to `local-adb`; this first version supports one enrolled connector. Rotate the token to revoke it. Do not paste tokens in the page, repository or command arguments. The existing browser-facing management endpoints retain their original access model; protect them with Cloudflare Access as appropriate. If Access also protects the heartbeat, a separate service authentication configuration is needed.

Run `npm run prepare:deploy` to create an allowlisted upload directory under `work/`. Deploy that returned directory to the **existing** Pages project with `wrangler pages deploy <directory> --project-name <existing-project>`. Never upload the source root, since it contains local credentials and connector state. The original domain remains `https://redred-1vl.pages.dev`.

### Local verification and connector startup

Requires Node.js 24.14+ and the existing ADB executable. No connector npm dependencies are required.

```powershell
npm test
npm run setup:local
node C:\Users\86188\node_modules\wrangler\bin\wrangler.js d1 execute mcn-account-management --local --file=migrations/0003-device-connector.sql
node C:\Users\86188\node_modules\wrangler\bin\wrangler.js pages dev . --port 8788 --d1=DB=d419f8a9-ed62-4b1b-9d90-271c0d41f29d
```

In a second terminal:

```powershell
node connector/adb-connector.mjs --dry-run
node connector/adb-connector.mjs --once
node connector/adb-connector.mjs
```

`setup:local` generates an ignored local token and local connector config; it is only for localhost testing. After deploying, use the separate production connector config. Keep the connector running for continuous sync; Ctrl+C stops it. Pairing still happens through Android wireless debugging and `adb pair` before discovery. The collector does not open network ports or pair phones automatically.

### Automatic wireless reconnection

Each collection cycle discovers `_adb-tls-connect._tcp` services and reconnects known devices using their current IP/port. The connector remembers device references and endpoints, handles a changed service suffix using the known hardware-reference hash, and retries a changed endpoint immediately. Failed unchanged endpoints back off for 30 seconds, with at most three 5-second connection attempts per cycle. Unknown devices and pairing service ports are never connected automatically. Device identity and existing database IDs are preserved across reconnects.

Local and production configurations now have independent state files to avoid concurrent writes. The first run imports the previous `local-adb.json` cache automatically. If no discoverable service exists, the last known endpoint is retried, and a disconnected diagnostic is reported. The UI distinguishes a stopped connector from a running connector with an unreachable phone. Automatic recovery requires the phone to advertise wireless debugging and the local network to carry mDNS; a disabled phone-side service or isolated Wi-Fi cannot be restored by the computer alone.

### Cloud connectivity and proxy settings

The connector respects HTTP(S) proxy environment variables. On Windows, when no explicit proxy is set, it reads the enabled per-user system proxy so that cloud requests follow the same route as the browser. `proxy_url` can override the proxy in the ignored local config; `use_system_proxy: false` disables Windows system-proxy detection. Localhost ADB/Appium requests bypass the proxy. Certificate verification remains enabled, and proxy credentials are never printed. Restart the connector after changing proxy configuration. A cloud network error includes its cause code in the local log and will retry on later cycles; the backend marks stale telemetry offline instead of claiming that a connected phone is still reporting.

The current connector is a running local process, not a Windows startup service. Computer restart still requires starting it again. Appium device sessions and task execution remain separate follow-up work.

### Pause and resume wireless devices

The device row provides **Pause connection** and **Resume connection**. Pause is persisted in D1 and the local connector cache. The connector fetches the authenticated control policy before each cycle, disconnects the selected wireless phone, skips its telemetry, and excludes it from automatic reconnection. Resume becomes online only after the phone reconnects and the connector acknowledges the current control revision. Account links, names, notes and the last telemetry are preserved. Requests are normally handled on the next 20-second cycle. If the connector is stopped or cannot fetch the current policy, the UI keeps the request pending rather than falsely claiming completion. Cached pauses are still enforced on cloud failures and after restarting the connector.

For an existing database, apply `migrations/0004-device-connection-control.sql` once before deploying this feature. Do not reapply earlier migrations. No table recreation is needed. Provision a separate Pages production secret `DEVICE_CONTROL_TOKEN` with `node configure-device-control.mjs redred <wrangler.js>`. The generated browser control code is saved only in ignored `connector/device-control.local.json`; it is separate from the connector token. The browser asks for this code on the first control action and retains it only for the current tab session. No code is embedded in the HTML, URLs, or repository.

On the current workstation and production database, migration 0004 has already been applied. `setup-local.mjs` configures a separate development control code in `connector/device-control.dev.local.json`. Production verification passed: pause was acknowledged, ADB became empty, telemetry stayed unchanged over multiple cycles, restarting the connector preserved pause, and resume restored the same single device record online. Automated checks: 13 passing tests. The device was restored to active/online after verification.

Protocol: `PATCH /api/devices/:id` with `{"connection_action":"pause"}` or `"resume"` and header `x-device-control-token`; `GET /api/connectors/control` requires the connector Bearer token. Heartbeats carry revisioned `control_results`. Old acknowledgements cannot overwrite newer requests, and delayed telemetry cannot undo a pause. This first version controls enrolled wireless devices; USB connections must be unplugged to fully disconnect. Appium task execution will need to honor the same desired state when it is implemented.

## Scope

- Work accounts: country calling code + phone number as the account identity, display name, status, notes. Phone numbers are not checked against a format regex.
- Devices: name, manufacturer, model, operating system/version, inventory status, connector status, last seen, battery, and screen resolution.
- Login history: account/device association, confirmation time, status, notes.
- No passwords, cookies, verification codes, device fingerprint changes, or platform actions are stored or performed.
- No demo records are inserted; the initial state is empty.

## Existing database upgrade

If D1 already has the original schema, apply the additive migration once:

```sh
npx wrangler d1 execute mcn-account-management --remote --file=migrations/0002-phone-and-device-telemetry.sql
```

For the local preview database, apply the same migration with `--local`. Use `schema.sql` only for a brand-new database. The migration preserves existing rows; old account handles remain visible as a fallback until those rows are updated with phone details.

## Local setup

Requires Node.js and Wrangler. From this directory:

```sh
npm install --save-dev wrangler
npx wrangler d1 create mcn-account-management
```

Copy the returned database ID into `wrangler.toml`, then initialize and run:

```sh
npx wrangler d1 execute mcn-account-management --local --file=schema.sql
npx wrangler pages dev . --d1=DB=<database_id>
```

Replace `<database_id>` with the value in `wrangler.toml`. This explicitly binds the local D1 database to the Pages Function as `env.DB`.

## Cloudflare deployment

Create the D1 database, set its ID in `wrangler.toml`, and apply the schema only if it is a new database:

```sh
npx wrangler d1 create mcn-account-management
npx wrangler d1 execute mcn-account-management --remote --file=schema.sql
npx wrangler pages deploy .
```

In the Pages project settings, bind the D1 database as `DB`. Restrict the app with Cloudflare Access before putting real account metadata in it. The starter API has no application-level user/role system.

## API

- `GET/POST /api/accounts`
- `GET/PATCH /api/accounts/:id` (status change)
- `GET/POST /api/devices`
- `GET/PATCH /api/devices/:id` (status change)
- `PATCH /api/devices/:id` also accepts `name` and `notes`
- `GET /api/connectors` (configuration and last heartbeat status; no token returned)
- `POST /api/connectors/heartbeat` (Bearer connector token; full device snapshot)
- `GET/POST /api/sessions`
- `PATCH /api/sessions/:id` with `ended` or `verification_needed`

The login-session form is an operator assertion that a login was completed. It does not inspect a phone or verify the platform session.

## Shared device connection design

Opening the Pages URL in a browser cannot read USB devices or run ADB on another person's computer. `127.0.0.1` is local to each person's own machine and is not a shared URL.

For shared cloud collaboration, deploy the Pages app and protect it with Cloudflare Access. The local connector discovers authorized devices and sends an allowlisted heartbeat over outbound HTTPS to the authenticated Pages Function. The web app reads the resulting device rows from D1. Do not expose ADB ports to the public internet or give the connector Cloudflare account OAuth credentials.

The connector implementation is in `connector/adb-connector.mjs`; ingestion is in `functions/api/connectors/heartbeat.js`. Avoid collecting IMEI, Android ID, MAC address, app data, or account session contents.

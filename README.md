# MCN account management MVP

Minimal Cloudflare Pages + D1 application for maintaining work-account records, device records, and operator-confirmed login history.

## Device auto-sync (2026-10-21)

Production deployment has been verified on `https://redred-1vl.pages.dev/#devices`. Migration 0003 is already applied remotely; do not reapply it. The original account is preserved, and a real Xiaomi phone has been imported and repeatedly synced into the remote database with the same device ID. Current production deployment: `128d6e1f.redred-1vl.pages.dev`.

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

Requires Node.js 22.13+ and the existing ADB executable. No connector npm dependencies are required.

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

`setup:local` generates an ignored local token and local connector config; it is only for localhost testing. After deploying, change the connector's `api_url` back to the existing HTTPS domain and configure the production connector secret. Keep the connector running for continuous sync; Ctrl+C stops it. Pairing still happens through Android wireless debugging and `adb pair` before discovery. The collector does not open network ports or pair phones automatically. Reconnection requires the phone to remain reachable through ADB/mDNS.

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

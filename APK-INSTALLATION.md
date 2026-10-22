# Manual APK installation

This extends the existing Cloudflare Pages / D1 app and the local ADB connection. It does not use AWS or cloud phones. APK bytes stay on the computer attached to the phone. The website stores file names, sizes, SHA-256 hashes, task state and result messages, never arbitrary local paths.

## Start the local processes

Use Node.js 24.14 or newer. Keep the telemetry connector and APK installer running:

```powershell
cd D:\Codex\account-management\outputs\account-management-mvp
powershell -NoProfile -ExecutionPolicy Bypass -File connector\start.ps1 -Production
```

In another terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\Codex\account-management\outputs\account-management-mvp\connector\start-apk-installer.ps1
```

The installer uses the same ignored production connector configuration and token. Only one installer process can use a configuration at once. Up to three different devices can install concurrently. Each device permits one pending or running installation. Windows startup registration is not configured.

## Install from the existing website

1. Put an APK directly in `D:\Codex` or `D:\Codex\account-management\work\apks`. Subdirectories and arbitrary server-provided paths are not accepted. The catalog updates about every 20 seconds, supports up to 100 distinct packages and files up to 1 GiB.
2. Open the Devices page, restore connection if paused, and wait for the device to be online and available.
3. Click the device's Install APK button, select a package and enter the existing device control code if the tab is not already authorized.
4. Keep the phone unlocked and approve its installation prompt if requested. On Xiaomi devices, the developer option named USB installation may also be required for wireless ADB installation.
5. The dialog refreshes installation history every 10 seconds. Success requires ADB's `Success` response. The executor uses `adb -s <verified transport> install -r <local file>`, preserving existing app data. It never silently uninstalls, permits downgrade, or substitutes another phone.

The executor rehashes the local package and matches the hardware-derived device reference before starting. It fetches the current pause policy immediately before installation. Signature conflicts, downgrade refusal and device confirmation refusal are reported as failures. Timeouts/disconnections after an attempted installation are recorded as unknown; inspect the phone before creating another task. Unknown jobs are not automatically retried. Interrupted processes preserve a local journal and report unknown on restart. Old queued jobs expire after 20 minutes.

## Database and deployment

For the existing local and remote databases, apply only `migrations/0005-apk-installations.sql` using `wrangler d1 execute --file ...` with the appropriate local/remote flag. Do not replay older migrations: their columns already exist and the old deployments did not consistently use the migrations tracking table.

Create the allowlisted upload with `npm run prepare:deploy`. Never deploy the source directory or publish connector credentials, APKs, installer state, local login screenshots, or the friend's cloud session files.

## Login scope

The friend's `scripts/run_login_to_sms.py` and `scripts/login_from_here.py` contain cloud-session-dependent phone-entry flows that stop at the SMS verification screen. They are not a complete login-by-account implementation, are not connected to the backend account list, and contain a fallback phone number and resolution-specific coordinates. They have not been run or copied into this installation feature. Local account selection, verification input and proof of the resulting logged-in identity remain separate work.

# Local RedNote login and script testing

This version uses a selected physical Android device and an existing work-account record. It does not use AWS or account/device groups.

## Appium connection

Set `appium_url` in the ignored production connector configuration to `http://127.0.0.1:4723` and restart the telemetry connector. Its Appium badge reports server health, not proof that each phone can execute commands. A separate real-device session test is required.

On the current Xiaomi device, normal Appium initialization is blocked by protected system settings and APK installation permissions. The installed UiAutomator2 driver's three helper APKs were copied to `Download/Appium` and installed manually by the operator. A session was successfully created with `noReset`, `autoLaunch=false`, `ignoreHiddenApiPolicyError`, `skipDeviceInitialization`, `skipServerInstallation`, and `skipUnlock`. The script deliberately reuses the already installed helpers rather than reinstalling them. Prepare matching helpers again after upgrading the driver.

## Manual account login

1. In Devices, select More > Account login. Alternatively open Login history > Select account login.
2. Select the existing work account and the online, available device.
3. Complete login on that phone using the displayed country code and phone number. Enter SMS verification directly on the phone. No password or verification code is stored by this feature.
4. Check the profile/account on the phone, tick the explicit confirmation, enter the existing device control code if needed, and save.

This is an operator assertion of the logged-in identity, not automatic identity verification. Selecting an account alone does not log the phone in. Creating or changing a login record requires device-control authorization. Duplicate confirmation is idempotent. Confirming a different account ends the prior active record for the same device and platform; it does not sign accounts out on the phone or other devices.

## Reproducible script

From the project directory:

```powershell
node connector/rednote-appium.mjs --url NOTE_SHARE_URL --title EXPECTED_TITLE --author EXPECTED_AUTHOR
```

The script resolves supported share links, verifies the physical device by its existing hashed reference, checks current device/account policy and the manually confirmed login record, refuses active UiAutomator2 instrumentation on that phone or pending APK installations, opens the exact note, and checks author and title. It captures only a verified note screenshot and a result summary under `work/script-tests`. It does not require Appium's optional session-discovery feature.

Keep the phone unlocked with the screen on during testing. The script refuses an asleep/dozing device before creating a session. Add `--device-id` and `--account-id` when there is more than one enrolled device/account. Add `--like` only to run the ensure-liked operation on the explicitly selected note. A clear already-liked state is skipped; an unliked state is clicked once and checked again. Ambiguous identity, ambiguous controls, disconnects and unconfirmed results stop without automatic retry. No arbitrary right-hand icon fallback is used.

The current selector recognizes the bottom Android button's explicit Like/Unlike description and selected state. App updates may change these semantics; revalidate on the target app version. There is no bulk engagement task scheduler in this version.

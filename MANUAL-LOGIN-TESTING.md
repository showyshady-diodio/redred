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

Keep the phone unlocked with the screen on during testing. The script refuses an asleep/dozing device before creating a session. Add `--device-id` and `--account-id` when there is more than one enrolled device/account. Add `--like` to ensure the selected note is liked, `--collect` to ensure it is collected, or both flags to perform both checks in order. Each action rereads the current note identity and its own button state. Completed actions are skipped; an incomplete action is clicked once and read back up to four times without another click. Ambiguous identity, ambiguous controls, disconnects and unconfirmed results stop without automatic retry. No arbitrary right-hand icon fallback is used.

The current selectors recognize the bottom Android buttons' explicit Like/Unlike and Collect/Uncollect descriptions and selected states. App updates may change these semantics; revalidate on the target app version. There is no bulk engagement task scheduler in this version.

## Current physical-device validation

On 2026-10-22, Appium 3.8.0 / UiAutomator2 8.7.0 created a real session on the enrolled Xiaomi Android 14 phone. The operator confirmed the sole work-account login, and the existing backend stored that manually confirmed account/device relationship.

The share link supplied by the operator resolved to note `6ab8fa30000000001a025203`. Read-only testing verified author `Zyq`, title `还我行李箱`, and the bottom button description `点赞 2` (not liked). The note could be opened through its resolved canonical URL; the short-link hostname itself was not handled by this app version.

An earlier like attempt was rejected with `InputManager: Permission Denial ... requires android.permission.INJECT_EVENTS`. After the operator inserted a SIM and completed the phone-side setup, the targeted real-device retest passed: one like click changed `点赞 2` to `已点赞3`, and one collect click changed `收藏 0` to `已收藏1`. The action report and screenshots are in `work/script-tests/2026-10-22T14-13-21-140Z` on the attached computer.

A second run reopened the same note, read `已点赞 3` / `已收藏 1`, returned `already_liked` and `already_collected`, and skipped both clicks. The corresponding report is in `work/script-tests/2026-10-22T14-14-08-849Z`. These counts describe the observed page state; the state descriptions, rather than count changes alone, are the success criterion. All 21 automated tests passed.

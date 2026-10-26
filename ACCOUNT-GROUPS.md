# Fixed device account groups

Each device is its own fixed account group. A work account belongs to at most one
device. Register its exact RedNote number from the profile, not its phone number
or display name. First sign in manually and retain it in the app account switcher.

Device More > fixed account group manages saved accounts. Confirm current account
only records an operator assertion; it does not sign in or switch the phone.
Group membership does not mean multiple simultaneous active sessions.

For grouped task runs the immutable snapshot includes the RedNote number. Before
opening a note the local worker opens the profile, switches to the exact saved
account if needed, then reads the profile number again. It reports the confirmed
identity using the active execution lease. Only then does it open the task note.
Missing accounts, verification prompts and identity mismatch stop execution.
The operator can resolve verification on the phone and explicitly retry the task.
There is no automatic SMS handling or exported login token storage.

Legacy manually confirmed accounts remain compatible. Add them to the device
group to enable automatic identity verification and switching.

Deploy migration 0008 once using D1 execute --file, then deploy Functions/UI and
restart the local task worker. Keep the phone unlocked. Two saved accounts were
tested on 2409BRN2CA; no maximum saved-account capacity or session lifetime is
assumed. Device account changes require an idle device/account.

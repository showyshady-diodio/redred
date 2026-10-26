# Account groups and device bindings

Account groups exist independently of devices. Create and name a group from work
accounts, then select its members. An account belongs to at most one group in this
version. A device binds either one group or one account directly. Unbinding a
device preserves the group, its members, account identity and phone login state.
Current fixed-device operation permits each group/account on at most one device.

Work accounts > account grouping manages groups. Account row More > account
grouping preselects that account. Device More > bind accounts selects a group or
one account. Register each exact RedNote number from the profile before binding;
grouping itself does not require login or a RedNote number. First sign in manually
and retain each selected account in the app account switcher. Confirm current account
only records an operator assertion; it does not sign in or switch the phone.
Group membership does not mean multiple simultaneous active sessions. Bound
group membership changes update available device accounts atomically. Conflicting
device assignments and changes during pending/running tasks are rejected.

For grouped task runs the immutable snapshot includes the RedNote number. Before
opening a note the local worker opens the profile, switches to the exact saved
account if needed, then reads the profile number again. It reports the confirmed
identity using the active execution lease. Only then does it open the task note.
Missing accounts, verification prompts and identity mismatch stop execution.
The operator can resolve verification on the phone and explicitly retry the task.
There is no automatic SMS handling or exported login token storage.

Legacy manually confirmed accounts remain compatible. Add them to the device
group to enable automatic identity verification and switching.

Deploy migration 0009 after 0008, then deploy Functions/UI and
restart the local task worker. Keep the phone unlocked. Two saved accounts were
tested on 2409BRN2CA; no maximum saved-account capacity or session lifetime is
assumed. Migration 0009 preserves existing assignments as independent account
groups and device bindings. The previous device-accounts write endpoint returns
410 to prevent cached clients from editing the old model.

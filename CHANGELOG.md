# Changelog

All notable changes to Focus Block are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- macOS `.dmg` in CI as a universal binary — one artifact runs natively on Apple Silicon and Intel
  (`--target universal-apple-darwin`, both rust targets installed via the matrix).
- Ad-hoc code signing for the macOS bundle (`bundle.macOS.signingIdentity: "-"`), so Gatekeeper
  reports "unidentified developer" rather than a damaged app. No Apple Developer account required.

### Security

- **The install path no longer hands root a file it can be tricked into trusting.** `enable_saved_auth`
  staged the helper body and the sudoers rule under `/tmp` and had `pkexec` copy them, so anything
  running as the user could rewrite both while the password dialog was open — that is arbitrary code as
  root plus a root rule of the attacker's choosing. Both now travel as argv into a fixed root-side
  script that renders and validates everything itself; nothing user-writable is read as root.
- **The sudoers rule is validated before it is installed.** An unparseable file in `/etc/sudoers.d`
  makes `sudo` refuse to run system-wide, so the rule is staged outside that directory and checked with
  `visudo -cf` first.
- **Install is all-or-nothing.** The rule is staged and validated before either live file is touched, so
  a failed install leaves the previous state intact instead of a new helper paired with an old rule.
- `chown root:root` is explicit on both installed files rather than inherited from `pkexec`.
- The username fallback is gone. A failed detection used to write a rule for that hardcoded name; it now
  errors out, and the name is restricted to `[A-Za-z0-9._-]` before it reaches the rule.
- Dropped the Linux `sudo -n cp` fallbacks that could write `/etc/hosts` without passing through the
  helper, so the helper stays the single passwordless entry point. macOS keeps its `sudo -n` attempt,
  which only succeeds on the user's own cached sudo ticket and grants nothing extra.
- **The passwordless helper no longer writes caller-supplied content.** It used to copy a file whose
  bytes anyone running as the user could choose — arbitrary `/etc/hosts` content without a password
  (redirect or blackhole any domain), and a time-of-check/time-of-use gap where `[ -L ]` then `cp`
  could be raced into copying a root-only file such as `/root/.ssh/id_rsa` into world-readable
  `/etc/hosts`. The helper now takes `block <domain>…` / `clear`, validates every name against
  `a-z0-9.-`, and renders the `127.0.0.1` / `::1` lines itself, so the worst a hostile caller can do is
  ask for a domain to be blocked. There is no staging file left to race, pre-create or symlink, and the
  passwordless path no longer touches `/tmp` at all.
- **`/etc/hosts` is replaced atomically.** The section is built beside it and moved into place, so a
  crash mid-write can no longer truncate the file and take DNS down for the whole machine.

### Changed

- **Helper protocol changed to `block <domain>…` / `clear`** and the sudoers rule with it. A helper
  installed by 0.1.1/0.2.0 only understands a file path, so the app keeps driving it in its old protocol
  until you re-enable; `check_saved_auth` reports `helper_version` and Settings shows a notice when the
  installed helper is outdated, otherwise the upgrade would silently leave the old behaviour in place.
- Window-close cleanup now calls `deactivate_blocks` instead of carrying its own copy of the privileged
  write, so there is one implementation of that path rather than two that could drift.
- `www.` aliases are expanded in `expand_sites` instead of `build_block_section`, which is now a plain
  renderer that matches what the helper produces for the same domain list (verified byte-for-byte).
- **Day-session is now Saved authorization.** One authorization instead of a per-day one: it no longer
  resets at midnight, so it stays on until you disable it. Disabling still restores a password prompt at
  every Start and End. Upgrading from 0.1.1: the old `0 0 * * *` job removes itself at the next midnight,
  so the authorization is cleared once and then, re-enabled, is permanent (enabling also deletes the job
  immediately if it is still present).
- `check_day_session` → `check_saved_auth`, `setup_day_session` → `enable_saved_auth`,
  `disable_day_session` → `disable_saved_auth`. The check response is now just `{ enabled, platform }` —
  the previously returned `cron_active`, `helper`, `sudoers` and `mtime` fields were never read by the UI.
- Release assets no longer include the raw `.app` directory — it was published as loose files and was
  not launchable. The `.dmg` is the macOS deliverable.
- CI now actually passes the matrix `bundles` list to `tauri build --bundles`; previously the value
  was configured but never used, so builds relied on `bundle.targets: "all"`.

### Fixed

- macOS: `killall -HUP mDNSResponder` now runs inside the existing `osascript` admin prompt, the only
  point where the app holds root. It previously ran unprivileged after the prompt closed and failed
  silently, so a just-blocked site could stay reachable until the resolver cache expired. The flush is
  guarded so a failed flush cannot fail a successful hosts write.
- macOS/Windows: the Settings day-session toggle is no longer rendered, since day-session is
  Linux-only and the action could only ever fail with "Linux only". Unknown platform still shows the
  toggle, so Linux behaviour is unchanged.
- Removed three redundant `cfg(target_os = "linux")` / `cfg(not(..))` pairs on the hosts-blocking path
  constants — both sides defined the same value.

## [0.1.1] - 2026-08-27

First release.

### Added

- Tasks — title, duration 1–480 min, per-task blocked domains, `createdAt`.
- Global blocks — merged with per-task domains when a session starts.
- Session timer — `MM:SS` countdown, progress bar, automatic hosts cleanup on finish; adding, editing
  and deleting tasks is locked while a session runs.
- Hosts blocking — `127.0.0.1` and `::1` entries for each domain plus a `www.` alias for apex
  domains, written into a managed region of `/etc/hosts` between marker comments, followed by a DNS
  cache flush.
- Domain aliases — `twitter.com ↔ x.com ↔ t.co`, `youtube.com ↔ youtu.be ↔ m.youtube.com ↔
  youtube-nocookie.com`, `instagram.com ↔ ig.me`, `facebook.com ↔ fb.com`, `reddit.com ↔
  old.reddit.com`.
- Day-session (Linux) — one authorization per day via helper `/usr/local/bin/focusblock-apply`,
  sudoers `/etc/sudoers.d/focusblock` and a `0 0 * * *` cron reset; subsequent Start/End use a
  `sudo -n` path with no prompt.
- SQLite storage — `rusqlite` (bundled) in the app data directory with WAL: `todos`, `global_blocks`,
  `active_session`; one-time migration from `localStorage`.
- Session integrity — window close is blocked while a session is active, and an orphaned hosts block
  left by a crash or `kill -9` is auto-recovered on the next launch.
- Packages — `.deb`, `.rpm`, `.AppImage`, `.msi`, `.exe`.
- Dark mode.

### Notes

- Blocking edits `/etc/hosts`, so Start and End need admin rights: `pkexec`/`sudo` on Linux, an
  `osascript` admin prompt on macOS, "Run as Administrator" on Windows. Day-session reduces that to
  one prompt per day, and is Linux only — macOS and Windows prompt on every Start and End.
- The released macOS build is not notarized (no Apple Developer account), so Gatekeeper blocks the
  first launch. Right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/FocusBlock.app"`.

[Unreleased]: https://github.com/musa-labs-indonesia/focus-block/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/musa-labs-indonesia/focus-block/releases/tag/v0.1.1

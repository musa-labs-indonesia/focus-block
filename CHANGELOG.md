# Changelog

All notable changes to Focus Block are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- macOS `.dmg` built in CI as a universal binary (Apple Silicon + Intel).
- Ad-hoc signing for the macOS bundle, so Gatekeeper says "unidentified developer" instead of "damaged".
- Uninstall hooks (deb/rpm) remove the helper and the sudoers rule; AppImage has no hook, so there it is manual.
- CI refuses a release whose tag does not match the packaged version.

### Security

- Root receives the domain list as arguments, never a file it could be tricked into copying.
- The sudoers rule is validated with `visudo -cf` before it is installed.
- Installing is all-or-nothing, with explicit `root:root` ownership on both files.
- The helper takes `block <domain>…` / `clear` and renders the section itself, so caller-supplied file content cannot reach `/etc/hosts`.
- `/etc/hosts` is swapped in by rename from the same directory, so a crash cannot truncate it.
- Every prompted write runs the renderer inside the command being authorized; `/tmp` is out of the write path.
- An old (v1) helper is refused, and the next prompted write replaces it — which is what makes a stale rule inert.
- `pkexec` and `sudo` are called with absolute paths, so the caller's `PATH` cannot choose the root program.
- Windows: a cancelled UAC prompt fails instead of reporting success, markers compare case-sensitively, the file's encoding is preserved, and the swap uses `[IO.File]::Replace`.
- Concurrent writes cannot blend: the renderer's staging file is per-run (`mktemp` plus a cleanup trap).
- The username check rejects the sudoers keyword `ALL`.

### Changed

- Day-session is now **Saved authorization**, and no longer resets at midnight.
- The helper protocol is `block <domain>…` / `clear`, with the sudoers rule rewritten to match.
- `check_saved_auth` replaces `check_day_session` (and `enable_saved_auth` / `disable_saved_auth` the others); the response is `{ enabled, platform, helper_version }`.
- `enabled` now means the passwordless path actually works, so an outdated install reads as disabled with a one-password re-enable.
- Settings offers the authorization toggle only once the backend reports Linux.
- `www.` aliases expand in `expand_sites`, so the app and the helper render identical sections.
- The unused `opener` plugin is gone and a Content Security Policy replaces the empty one.
- Window-close cleanup calls `deactivate_blocks` rather than duplicating the privileged write.
- Release assets drop the loose `.app` directory; the `.dmg` is the macOS deliverable.
- CI now passes `--bundles` to `tauri build`; the matrix value was previously ignored.

### Fixed

- macOS: the DNS flush runs inside the admin prompt, where it has the permission it needs.
- `activate_blocks` errors out instead of silently starting a session that blocks nothing.
- The finish toast only claims blocks were cleared when the clear actually succeeded.
- Removed redundant `cfg(target_os = "linux")` / `cfg(not(..))` pairs on the blocking constants.

### Upgrading from 0.1.1

- A 0.1.1 helper is refused, so writes ask for a password until you press **Enable saved authorization** — one password, after which the stale rule is inert.
- The old `0 0 * * *` job deletes itself at the next midnight, and enabling removes it immediately.

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

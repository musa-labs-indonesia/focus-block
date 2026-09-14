# Focus Block

Deep work timer that actually blocks distractions. Create tasks with a duration and blocked domains — `Focus Block` writes them to `/etc/hosts` (all browsers, system-wide) and runs a timer with **no pause, no stop, no escape**. Built with **Tauri 2 + React + Rust + SQLite**.

## Features

- **Tasks** — title, duration 1–480 min, per-task blocked domains, `createdAt`
- **Global blocks** — applied to every session (merged with per-task list on Start)
- **Timer** — `MM:SS`, progress bar, auto-clears hosts on finish, locks edit/delete/add while running
- **Hosts blocking** — `127.0.0.1` + `::1` for apex + `www.` alias, section `# BEGIN FOCUSBLOCKER` → `# END FOCUSBLOCKER` (`# BEGIN BLOCKER2` from 0.1.1 is still stripped on sight), `resolvectl`/`systemd-resolve` flush
- **Domain aliases** — `twitter ↔ x.com ↔ t.co`, `youtube ↔ youtu.be ↔ m.youtube ↔ youtube-nocookie`, `instagram ↔ ig.me`, etc. (Rust `domain_aliases`)
- **Saved authorization** (Linux) — one password, then no prompts ever: helper `/usr/local/bin/focusblock-apply` + sudoers `/etc/sudoers.d/focusblock`, `sudo -n` path. Persists until disabled; disable restores a password at every Start/End. Removing the package (deb/rpm) removes both; an AppImage has no uninstall hook, so disable it first or delete both paths by hand
- **SQLite** — `rusqlite 0.31 bundled` at `~/.local/share/com.muhsalaa.focusblock/focusblock.db` (WAL): `todos`, `global_blocks`, `active_session`; migrates once from `localStorage`
- **Hard block close** — `CloseRequested` prevented while `active_session.end_at > now` (Rust + frontend `onCloseRequested` toast), orphan hosts auto-recovered on next launch
- **Reject → no session** — if `pkexec`/`sudo` rejected, `activate_blocks` fails and session does not start

## How Blocking Works

1. Start merges `globalBlocks + todo.blockedSites` → `expand_sites` (normalize, dedup, alias expand, add `www.` for two-label domains)
2. Reads `/etc/hosts`, strips the old block, then applies the domain list:
   `try_write_hosts_direct` → `sudo -n helper block <domains…>` (standing authorization) → prompted write.
   Every privileged path hands root the **domain names**, never a file. The renderer validates each name
   and builds the section itself, and it runs *inside* the command being authorized (`pkexec` on Linux,
   `osascript` on macOS, an encoded PowerShell command on Windows). Nothing this process can write is ever
   read as root, so there is no staging file to race.
3. `deactivate_blocks` on timer end / window close (best-effort, and the only implementation of that path) / orphan recovery on next launch

## Tech Stack

- **Frontend:** React 19, Vite 7, TypeScript 5.8, Tailwind 4, `@tauri-apps/api` 2
- **Backend:** Tauri 2, Rust, `rusqlite` (bundled SQLite), `serde`
- **Bundle:** `deb` / `rpm` / `AppImage` via `tauri.conf.json` `targets: all`

## Project Structure

```
focus-block/
├── src/
│   ├── App.tsx          # tasks, timer, global blocks, saved-authorization UI, sqlite via invoke
│   ├── App.css, index.css, main.tsx
│   └── assets/
├── src-tauri/
│   ├── src/lib.rs       # hosts logic, saved authorization, sqlite (get_todos/sync_todos, get/set_global_blocks, get/save/clear_active_session), close handler
│   ├── Cargo.toml       # tauri 2, rusqlite 0.31 bundled
│   ├── tauri.conf.json  # com.muhsalaa.focusblock, 1100×750, bundle all
│   └── icons/
├── dist/                # vite output (frontendDist)
└── package.json         # dev: vite, build: tsc && vite build, tauri: tauri
```

## Prerequisites

- Node 20+, Rust stable, `cargo`, `npm`
- Linux deps for Tauri (Debian/Ubuntu): `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- `pkexec` (polkit) or `sudo` for hosts writes; `resolvectl`/`systemd-resolve` for DNS flush

## Getting Started

```bash
npm install
npm run dev          # vite only (http://localhost:1420)
npm run tauri dev    # full Tauri window (recommended)
```

## Building

```bash
npm run build                 # tsc + vite → dist/
cargo check --manifest-path src-tauri/Cargo.toml
npx tauri build               # release + bundles
# outputs:
#   src-tauri/target/release/focus-block                 (binary 17M)
#   src-tauri/target/release/bundle/deb/FocusBlock_0.1.1_amd64.deb  (5.0M)
#   src-tauri/target/release/bundle/rpm/Focus Block-*.rpm
#   src-tauri/target/release/bundle/appimage/Focus Block_*.AppImage
```

## Installation

```bash
# from project root after build
pkexec dpkg -i src-tauri/target/release/bundle/deb/FocusBlock_0.1.1_amd64.deb
# or: sudo dpkg -i ... ; sudo apt-get install -f  # if deps missing
# launch:
focus-block
# or via app launcher: Focus Block
# .desktop: /usr/share/applications/FocusBlock.desktop → Exec=focus-block
```

## macOS (dmg)

Built only in CI (`.github/workflows/release.yml`, macOS job) — universal binary, Apple Silicon + Intel in one dmg.

```bash
npx tauri build --target universal-apple-darwin --bundles dmg
# needs both targets first: rustup target add aarch64-apple-darwin x86_64-apple-darwin
# output: src-tauri/target/universal-apple-darwin/release/bundle/dmg/FocusBlock_0.1.1_universal.dmg
```

The dmg is **ad-hoc signed, not notarized** (`bundle.macOS.signingIdentity: "-"` — no Apple Developer account). Gatekeeper will therefore refuse the first launch. Either right-click the app → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/FocusBlock.app"
```

Then Settings → Privacy & Security → **Open Anyway** if macOS still blocks it. Money-free fix for a proper signature later: an Apple Developer account + `APPLE_CERTIFICATE`/`APPLE_SIGNING_IDENTITY`/`APPLE_ID` secrets, no code changes needed.

Blocking works the same as Linux (`/etc/hosts`), but the macOS privilege path is `sudo -n` → `osascript … with administrator privileges`, so expect an admin prompt at each Start **and** Finish. **Saved authorization is Linux-only** — on macOS the toggle isn't offered, because there is no equivalent way to grant a standing rights escalation.

## Usage

1. **Create task** — `New task` → title, duration (15/25/45/60 shortcuts), per-task domains (e.g. `youtube.com` — validates `a-z0-9.-`, strips `https://`, `www.`, port/path)
2. **Global blocks** — Settings → `🌐 Global blocks` → `youtube.com` Enter. Locked during session.
3. **Start** — `▶ Start` merges global+per-task → prompts for password (or no prompt if saved authorization is enabled) → timer runs, UI locked, close blocked, `Hosts diagnostics` shows `⛔ N sites blocked`
4. **Finish** — auto `deactivate_blocks` + toast `is complete. Blocks cleared.` + `refreshBlockStatus`. Close button prevented until finish (toast `Cannot close — session running.`).
5. **Saved authorization** — Settings → `Enable saved authorization` → one `pkexec` → installs helper + sudoers `muhsalaa ALL=(ALL) NOPASSWD: /usr/local/bin/focusblock-apply block *, /usr/local/bin/focusblock-apply clear`. No password from then on, for every session, until you `Disable` (which removes both files). No schedule is installed — the old `0 0 * * *` reset is deleted when you enable.
6. **Search** — Focus page → `Find a task` filters by title
7. **Edit/Delete** — `✎` / `✕` disabled during session; running task cannot be edited/deleted

## Data & Storage

- **SQLite** (primary): `~/.local/share/com.muhsalaa.focusblock/focusblock.db`
  ```sql
  todos(id TEXT PK, title TEXT, duration_minutes INT CHECK 1..480, blocked_sites TEXT JSON, created_at INT)
  global_blocks(site TEXT PK)
  active_session(todo_id TEXT, start_at INT, end_at INT, duration_seconds INT) -- single row
  PRAGMA journal_mode=WAL
  ```
  ```bash
  sqlite3 ~/.local/share/com.muhsalaa.focusblock/focusblock.db "select * from todos; select * from global_blocks; select * from active_session;"
  ```
- **Migration:** if `todos`+`global_blocks`+`active_session` empty but `localStorage` has `focusblock_todos`/`focusblock_global_blocks`/`focusblock_active_session`, migrates once via `sync_todos`/`set_global_blocks`/`save_active_session` (fallback to `localStorage` when not in Tauri, e.g. `npm run dev`).
- **Hosts:** `/etc/hosts` block `# BEGIN FOCUSBLOCKER` managed, never edit manually; cleared on finish, on close (best-effort: saved-auth helper, then `pkexec`), or on next launch orphan recovery.
- **Old localStorage keys** kept for fallback only — not source of truth after first Tauri launch.

## Permissions

- **First Start/End without saved authorization:** `pkexec` dialog (system password)
- **Saved authorization enabled:** `sudo -n /usr/local/bin/focusblock-apply block <domain>…` (no prompt) and `sudo -n /usr/local/bin/focusblock-apply clear`. The helper validates every name against `a-z0-9.-` and renders the `127.0.0.1` / `::1` lines itself, then swaps the file in with `mv` — it never copies caller-supplied content, so a hostile caller can at most ask to block a domain, and a crash can't leave `/etc/hosts` half-written
- **Without saved authorization:** the same renderer runs under `pkexec` on Linux — installed or refreshed in the very same authorized command — or embedded in the macOS admin command / an encoded PowerShell command on the others. One prompt per Start/End, same validation, same atomic swap. Nothing is staged, so there is no file to swap out from under the prompt; and because that command rewrites the helper, the first prompted write after upgrading from 0.1.1 is what makes the old file-path rule inert
- **Trust model worth keeping:** the helper accepts `block <domain>…` or `clear` and nothing else, and renders the section from names it validates itself. Any future change that lets caller-supplied *content* become `/etc/hosts` re-opens the whole class of bugs this design removed
- **Files:** `/usr/local/bin/focusblock-apply` `755`, `/etc/sudoers.d/focusblock` `440`, both `root:root`. One `pkexec` stages the rule, validates it with `visudo -cf`, and only then installs — a rule that does not parse never reaches `sudoers.d`, and a failed install changes nothing. No cron file is installed — `/etc/cron.d/focusblock` only ever appears as a leftover from 0.1.1 and is removed on enable
- **Check:** `sudo -n -l` should show `(ALL) NOPASSWD: /usr/local/bin/focusblock-apply block *, /usr/local/bin/focusblock-apply clear`; `pkexec cat /etc/sudoers.d/focusblock` to inspect. `head -2 /usr/local/bin/focusblock-apply` should show `# focusblock-helper v2`

## Troubleshooting

- **Settings warns the helper is from an older version:** the install predates the domain-list protocol and is refused, so writes ask for a password. Press `Enable saved authorization` to replace it — one password, and the stale rule goes inert with it.
- **Saved authorization still asks password:** `pkexec chmod 755 /usr/local/bin/focusblock-apply; pkexec chmod 440 /etc/sudoers.d/focusblock; pkexec visudo -c` — must be `parsed OK`. Then `sudo -n /usr/local/bin/focusblock-apply clear` should `EXIT:0`. If still prompts, re-enable in Settings (disable → enable).
- **Orphan block after kill -9 / close reject:** next launch auto-detects `get_block_status().active && no active_session` → tries `deactivate_blocks` and shows `Orphaned block cleared` or manual clear prompt. Manual: `pkexec sed -i '/# BEGIN FOCUSBLOCKER/,/# END FOCUSBLOCKER/d' /etc/hosts` (add the same for the legacy `# BEGIN BLOCKER2` pair if an old block is still there)
- **Cannot close during session:** intentional — finish timer (no pause). If stuck, `kill` the `focus-block` process; on next launch orphan recovery will clear.
- **Sites not blocked:** check `Settings → Hosts diagnostics` preview contains `127.0.0.1 youtube.com` + `::1`; try `ping youtube.com` → should resolve `127.0.0.1`. Check `/etc/hosts` for block, `resolvectl flush-caches`.
- **Build fails `Cargo.toml` not found:** use `cargo check --manifest-path src-tauri/Cargo.toml` and `npx tauri build` from project root.
- **DB locked:** WAL mode handles concurrent; if `database is locked` after crash, `rm ~/.local/share/com.muhsalaa.focusblock/focusblock.db-wal` and restart.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Vite dev |
| `npm run build` | Type check + Vite prod |
| `npm run tauri dev` | Tauri dev window |
| `npx tauri build` | Release + deb/rpm/AppImage |

## Version

`0.1.1` — `com.muhsalaa.focusblock` — Tauri 2.11, Rust `rusqlite` bundled

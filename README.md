# Focus Block

Deep work timer that actually blocks distractions. Create tasks with a duration and blocked domains — `Focus Block` writes them to `/etc/hosts` (all browsers, system-wide) and runs a timer with **no pause, no stop, no escape**. Built with **Tauri 2 + React + Rust + SQLite**.

## Features

- **Design system** — locked in [`design.md`](design.md), tokens in [`tokens.css`](tokens.css) (OKLCH, light + dark). Type is bundled: Space Grotesk display, Inter body, JetBrains Mono for the countdown
- **Tasks** — title, duration 1–480 min, per-task blocked domains, `createdAt`
- **Global blocks** — applied to every session (merged with per-task list on Start); can be added to while a block is running, never removed from one
- **Timer** — `MM:SS`, progress bar, auto-clears hosts on finish, locks edit/delete/add while running
- **Hosts blocking** — `127.0.0.1` + `::1` for apex + `www.` alias, section `# BEGIN FOCUSBLOCKER` → `# END FOCUSBLOCKER` (`# BEGIN BLOCKER2` from 0.1.1 is still stripped on sight), `resolvectl`/`systemd-resolve` flush
- **Domain aliases** — `twitter ↔ x.com ↔ t.co`, `youtube ↔ youtu.be ↔ m.youtube ↔ youtube-nocookie`, `instagram ↔ ig.me`, etc. (Rust `domain_aliases`)
- **Saved authorization** (Linux) — one password, then no prompts ever: helper `/usr/local/bin/focusblock-apply` + sudoers `/etc/sudoers.d/focusblock`, `sudo -n` path. Persists until disabled; the toggle is locked while a session or a schedule is blocking. Removing the package (deb/rpm) removes both; an AppImage has no uninstall hook, so disable it first or delete both paths by hand
- **SQLite** — `rusqlite 0.31 bundled` at `~/.local/share/com.muhsalaa.focusblock/focusblock.db` (WAL): `todos`, `global_blocks`, `schedules`, `active_session`; migrates once from `localStorage`
- **Scheduled blocks** — up to 2 daily windows (hour ranges, no overlap) each with its own domains; while a window is open those domains plus your global blocks are blocked, closing the app is refused until it ends, and a window that is blocking can only gain sites — its hours, its sites and its removal wait until it ends
- **Hard block close** — `CloseRequested` prevented while a session runs **or** a scheduled window is open (`close_is_blocked` in Rust, plus a frontend toast naming when the window ends), orphan hosts auto-recovered on next launch
- **Reject → no session** — if `pkexec`/`sudo` rejected, `activate_blocks` fails and session does not start

## How Blocking Works

1. Start merges `globalBlocks + todo.blockedSites` → `expand_sites` (normalize, dedup, alias expand, add `www.` for two-label domains)
2. Reads `/etc/hosts`, strips the old block, then applies the domain list:
   `try_write_hosts_direct` → `sudo -n helper block <domains…>` (standing authorization) → prompted write.
   Every privileged path hands root the **domain names**, never a file. The renderer validates each name
   and builds the section itself, and it runs *inside* the command being authorized (`pkexec` on Linux,
   `osascript` on macOS, an encoded PowerShell command on Windows). Nothing this process can write is ever
   read as root, so there is no staging file to race.
3. `deactivate_blocks` on timer end, or on close once neither a session nor a window is holding the app (best-effort, and the only implementation of that path); orphan recovery on next launch
4. Every 30s, and after any change, `sync_blocks` recomputes what should be blocked — global blocks ∪ running
   session ∪ open scheduled windows — and writes only if the file would actually differ. So a scheduled
   window opens and closes by itself, a tick that changes nothing costs nothing, and startup cleanup can
   tell an orphaned block from a legitimately scheduled one

## Tech Stack

- **Frontend:** React 19, Vite 7, TypeScript 5.8, Tailwind 4, `@tauri-apps/api` 2
- **Backend:** Tauri 2, Rust, `rusqlite` (bundled SQLite), `serde`
- **Bundle:** `deb` / `rpm` / `AppImage` via `tauri.conf.json` `targets: all`

## Project Structure

```
focus-block/
├── src/
│   ├── App.tsx          # the two views + design-system primitives (Button, Chip, Icon, Info, NavTab)
│   ├── index.css        # base layer + a11y rules (tokens come from ../tokens.css)
│   ├── main.tsx         # entry; bundles the three fonts
│   └── assets/
├── src-tauri/
│   ├── src/lib.rs       # hosts logic, saved authorization, sqlite (get_todos/sync_todos, get/set_global_blocks, get/save/clear_active_session), close handler
│   ├── Cargo.toml       # tauri 2, rusqlite 0.31 bundled
│   ├── tauri.conf.json  # com.muhsalaa.focusblock, 1100×750, bundle all
│   └── icons/
├── design.md            # the locked design system every view reads before changing
├── tokens.css           # palette, type stacks, spacing, motion, and the Tailwind @theme registration
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
2. **Blocking** — Settings → `Blocking` → `youtube.com` Enter. It applies to every session, and while a block is running — a session or a scheduled window — you can add to it but not remove from it.
3. **Start** — `Start` on a task merges the global and per-task lists → one password prompt (none if authorization is enabled) → the timer takes over the top of the view, the list locks, and closing is refused
4. **Finish** — the block is released by the same writer that opened it, and the toast says what is left blocked (usually nothing, unless a scheduled window is open)
5. **Authorization** — Settings → `Authorization` → `Enable` → one `pkexec` → installs the helper at `/usr/local/bin/focusblock-apply` and the rule at `/etc/sudoers.d/focusblock`. No password from then on, until you press `Disable` (which removes both files). No cron job is installed — the old `0 0 * * *` reset is deleted when you enable. The mechanism sits behind the ⓘ next to the status line. The toggle is locked while a session runs or a schedule is blocking — the authorization it would change is what is holding the block — but `Refresh` still works
6. **Scheduled blocks** — Settings → `Scheduled blocks` → `Add window` → pick an hour range and add sites. Up to 2, and they cannot overlap; while one is open its sites and your global list are blocked, and the window shows `blocked now`. Focus Block has to stay open, and **closing it is refused while a window is open** — the same no-escape rule as a session. Setting a window up never requires choosing its hours in order: raising the start onto its end carries the end along. A window that is blocking *right now* can only grow — you can add sites to it, but its hours, its sites and its removal wait until it ends
7. **Search** — Focus → `Find a task` filters the ledger by title
8. **Edit/Delete** — the pencil and X on each row are disabled during a session, and the running task cannot be edited or deleted
9. **Technical details** — the raw `/etc/hosts` region, marker names, platform and helper version live in Settings → `Technical details`, collapsed by default. Nothing there needs attention unless you are troubleshooting

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
- **Hosts:** `/etc/hosts` block `# BEGIN FOCUSBLOCKER` managed, never edit manually; cleared on finish, on close when nothing is holding the window (best-effort: saved-auth helper, then `pkexec`), on uninstall, or by the next launch's orphan recovery.
- **Old localStorage keys** kept for fallback only — not source of truth after first Tauri launch.

## Permissions

- **First Start/End without saved authorization:** `pkexec` dialog (system password)
- **Saved authorization enabled:** `sudo -n /usr/local/bin/focusblock-apply block <domain>…` (no prompt) and `sudo -n /usr/local/bin/focusblock-apply clear`. The helper validates every name against `a-z0-9.-` and renders the `127.0.0.1` / `::1` lines itself, then swaps the file in with `mv` — it never copies caller-supplied content, so a hostile caller can at most ask to block a domain, and a crash can't leave `/etc/hosts` half-written
- **Without saved authorization:** the same renderer runs under `pkexec` on Linux — installed or refreshed in the very same authorized command — or embedded in the macOS admin command / an encoded PowerShell command on the others. One prompt per Start/End, same validation, same atomic swap. Nothing is staged, so there is no file to swap out from under the prompt; and because that command rewrites the helper, the first prompted write after upgrading from 0.1.1 is what makes the old file-path rule inert. A change that no session and no window asked for — an expired block left on disk, say — is never prompted for on a timer: it waits for you to press Apply.
- **Scheduled windows:** a window writes once when it opens and once when it closes, so without saved authorization that is two extra prompts a day, and none with it. Nothing else touches `/etc/hosts` in between — the 30s tick only writes when the desired block actually changed
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
| `cargo test` (in `src-tauri/`) | Test suite: domain validation, the managed `/etc/hosts` section, the schedule rules, and the macOS/Windows renderers. The renderer tests extract the script this app installs and run it against a sandbox hosts file |

## Version

`0.2.0` — `com.muhsalaa.focusblock` — Tauri 2.11, Rust `rusqlite` bundled

# Focus Block

Deep work timer that actually blocks distractions. You create a task with a duration and the sites to
shut; while it runs, Focus Block writes them into `/etc/hosts`, so every browser is covered — tabs you
already have open included. When the timer ends, they come back.

Tauri 2 · React 19 · Rust · SQLite. No account, no network, nothing leaves the machine.

## Install

Take the file for your platform from [Releases](../../releases):

| | |
|---|---|
| Linux | `FocusBlock_*_amd64.deb` → `sudo apt install ./FocusBlock_*_amd64.deb` (or `sudo dpkg -i`, then `sudo apt -f install` if deps are missing). `.rpm` and a no-install `.AppImage` are there too |
| macOS | `FocusBlock_*_universal.dmg`. It is not notarized, so the first launch needs Right-click → Open, or `xattr -dr com.apple.quarantine "/Applications/FocusBlock.app"` |
| Windows | `.msi` or `.exe` installer |

The first block asks for your system password. See *Saved authorization* below to stop that.

## Use

1. **New task** — a title, a duration (15/25/45/60 shortcuts), and optionally the sites to block, e.g.
   `youtube.com`.
2. **Settings → Blocking** — sites blocked in *every* session, on top of each task's own list.
3. **Start** — merges the two lists, blocks them, and locks the interface until the timer ends.
4. **Settings → Scheduled blocks** — up to 2 daily hour ranges that block on their own, e.g. 06:00–09:00.
   They cannot overlap, and while one is open its own sites and your global list are both blocked.

## Rules worth knowing

- **No escape while a block is running.** The app refuses to close during a session or a schedule, and
  the editor for both is locked. There is no pause and no cancel.
- **A schedule only applies while Focus Block is open.** Closing is refused while one is blocking — the
  same no-escape rule as a session. Killing the app does not release it either: the block stays in
  `/etc/hosts` until the next launch syncs it.
- **The block lists only tighten mid-block.** Adding a global site, or adding a site to the schedule that is
  blocking right now, stays allowed — those only make the block stricter. Removing waits until the block ends.
- **One site can be several names.** Blocking `x.com` also blocks `twitter.com` and `t.co`; `youtube.com`
  also blocks `youtu.be`, `m.youtube.com` and `youtube-nocookie.com`; and every two-label domain also blocks
  its `www.` form. That is why the status line counts the sites you configured while Technical details
  reports how many hostnames they became in `/etc/hosts`.
- **Killed or crashed?** The block stays in `/etc/hosts` (fail closed) and the next launch picks the
  session back up from the database.

## Saved authorization (Linux)

One password once, then never again: `Settings → Authorization → Enable` installs
`/usr/local/bin/focusblock-apply` and a rule at `/etc/sudoers.d/focusblock` that lets it run as root.
Without it, a block change that needs a password waits for the Apply button — one click, one password —
instead of asking on its own.

The helper accepts exactly two things, `block <domain>…` and `clear`, and renders the `127.0.0.1` / `::1`
lines itself from names it validates, so root is never handed file content to copy. `Disable` removes both
files again. If a block outlives the app (a crash, a forced quit), clear it without a prompt:

```bash
sudo -n /usr/local/bin/focusblock-apply clear
```

## Uninstall

```bash
sudo dpkg -r focus-block        # rpm: sudo rpm -e focus-block · AppImage: just delete the file
```

That removes the helper, the sudoers rule, and the block from `/etc/hosts`. Your tasks, global sites and
schedules stay in `~/.local/share/com.muhsalaa.focusblock/focusblock.db` — delete that file to start over.

The AppImage has no uninstall hook, so there it is manual: `Disable` saved authorization first, or
`/usr/local/bin/focusblock-apply` and the `NOPASSWD` rule at `/etc/sudoers.d/focusblock` stay behind.

## If something is stuck

```bash
pkexec sed -i '/# BEGIN FOCUSBLOCKER/,/# END FOCUSBLOCKER/d' /etc/hosts   # clear by hand (no saved authorization)
sudo -n /usr/local/bin/focusblock-apply clear                            # clear with saved authorization
sudo -n -l ; head -2 /usr/local/bin/focusblock-apply                      # the rule, then: # focusblock-helper v2
```

- **Closing is refused** — that is the point: the block ends when its timer or its hour range ends. A kill
  leaves the block in `/etc/hosts`; relaunch so it syncs, or clear it with one of the commands above.
- **Still asked for a password** after enabling saved authorization: run the checks above, then `Enable`
  again to reinstall the helper and the rule.
- **A site is not blocked:** check it is listed either in that schedule or in Settings → Blocking — while a
  schedule is open, the two are blocked together.

## Build from source

Needs Node 20.19+, a [Rust toolchain](https://rustup.rs), and on Linux the packages CI installs:
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`, plus
`pkexec` (polkit) or `sudo` for the block itself.

```bash
npm install
npm run tauri dev                                 # dev window (npm run dev serves the UI alone on :1420)
npx tauri build                                   # release + deb/rpm/AppImage under src-tauri/target/release/bundle/
cargo test --manifest-path src-tauri/Cargo.toml   # test suite
```

## More

- [`CHANGELOG.md`](CHANGELOG.md) — what changed, plus the upgrade notes for older installs
- [`design.md`](design.md) — the design system the interface follows
- `cargo test` covers domain validation, the managed `/etc/hosts` section, the schedule rules, and the
  macOS and Windows renderers

`0.2.2`

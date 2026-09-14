use std::fs;
use std::path::PathBuf;
use std::process::Command;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[cfg(target_os = "windows")]
const HOSTS_PATH: &str = "C:\\Windows\\System32\\drivers\\etc\\hosts";
#[cfg(not(target_os = "windows"))]
const HOSTS_PATH: &str = "/etc/hosts";
const MARKER_START: &str = "# BEGIN FOCUSBLOCKER";
const MARKER_END: &str = "# END FOCUSBLOCKER";
const MARKER_START_OLD: &str = "# BEGIN BLOCKER2";
const MARKER_END_OLD: &str = "# END BLOCKER2";
const HELPER_PATH: &str = "/usr/local/bin/focusblock-apply";
#[cfg(target_os = "linux")]
const SUDOERS_PATH: &str = "/etc/sudoers.d/focusblock";
// legacy: 0.1.1 installed this to wipe the helper at midnight. Only ever removed now, so a stale
// copy from an older install cannot silently revoke an authorization meant to persist.
#[cfg(target_os = "linux")]
const CRON_PATH: &str = "/etc/cron.d/focusblock";

// --- sqlite types ---
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: String,
    title: String,
    duration_minutes: i64,
    blocked_sites: Vec<String>,
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSession {
    todo_id: String,
    start_at: i64,
    end_at: i64,
    duration_seconds: i64,
}

/// A daily window. Hours are local clock hours and the range is half-open: 7 to 10 blocks from 07:00
/// through 09:59 and releases at 10:00.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Schedule {
    id: String,
    start_hour: i64,
    end_hour: i64,
    /// Raw as typed; aliases and `www.` are applied when the block is built, like global blocks.
    sites: Vec<String>,
    created_at: i64,
}

fn db_path(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let new_path = dir.join("focusblock.db");
    // migrate from the old identifier / old db name (focus-block)
    if !new_path.exists() {
        if let Ok(home) = std::env::var("HOME") {
            let old = PathBuf::from(format!(
                "{}/.local/share/com.muhsalaa.focusblock/focusblock.db",
                home
            ));
            if old.exists() {
                let _ = std::fs::copy(&old, &new_path);
            }
        }
    }
    Ok(new_path)
}

fn get_conn(handle: &tauri::AppHandle) -> Result<Connection, String> {
    let path = db_path(handle)?;
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS todos (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 480),
            blocked_sites TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS global_blocks (site TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY,
            start_hour INTEGER NOT NULL CHECK(start_hour BETWEEN 0 AND 23),
            end_hour INTEGER NOT NULL CHECK(end_hour BETWEEN 1 AND 24),
            sites TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS active_session (
            todo_id TEXT NOT NULL,
            start_at INTEGER NOT NULL,
            end_at INTEGER NOT NULL,
            duration_seconds INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn normalize_domain(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    // strip protocol
    if s.starts_with("https://") {
        s = s[8..].to_string();
    } else if s.starts_with("http://") {
        s = s[7..].to_string();
    }
    // strip www.
    // we keep original but will generate both variants later; so strip for dedup then re-add
    // remove path/query
    if let Some(idx) = s.find('/') {
        s = s[..idx].to_string();
    }
    if let Some(idx) = s.find(':') {
        s = s[..idx].to_string();
    }
    // remove port already via :
    s = s.trim().trim_end_matches('.').to_string();
    // strip www. for canonical form, but we will block both
    if s.starts_with("www.") {
        s = s[4..].to_string();
    }
    if s.is_empty() || !s.contains('.') {
        return None;
    }
    // basic validation: only allowed chars
    if s.chars().any(|c| !c.is_ascii_alphanumeric() && c != '.' && c != '-') {
        return None;
    }
    Some(s)
}

fn domain_aliases(domain: &str) -> Vec<String> {
    match domain {
        "twitter.com" | "x.com" | "t.co" => vec!["twitter.com".into(), "x.com".into(), "t.co".into()],
        "youtube.com" => vec![
            "youtube.com".into(),
            "youtu.be".into(),
            "m.youtube.com".into(),
            "youtube-nocookie.com".into(),
        ],
        "youtu.be" => vec!["youtube.com".into(), "youtu.be".into()],
        "instagram.com" => vec!["instagram.com".into(), "ig.me".into()],
        "facebook.com" | "fb.com" => vec!["facebook.com".into(), "fb.com".into(), "m.facebook.com".into()],
        "reddit.com" => vec!["reddit.com".into(), "old.reddit.com".into()],
        _ => vec![domain.to_string()],
    }
}

/// Half-open window: 7 to 10 blocks 07:00-09:59 and releases at 10:00.
fn schedule_is_active(schedule: &Schedule, hour: i64) -> bool {
    hour >= schedule.start_hour && hour < schedule.end_hour
}

/// At most two rules, each a forward range, and none overlapping another. One place decides what is
/// valid, so the UI can show the same message instead of inventing its own rules.
fn validate_schedules(schedules: &[Schedule]) -> Result<(), String> {
    if schedules.len() > MAX_SCHEDULES {
        return Err(format!("at most {} scheduled blocks", MAX_SCHEDULES));
    }
    for s in schedules {
        if s.start_hour < 0 || s.end_hour > 24 || s.start_hour >= s.end_hour {
            return Err("each scheduled block needs a start hour before its end hour".to_string());
        }
    }
    for (i, a) in schedules.iter().enumerate() {
        for b in schedules.iter().skip(i + 1) {
            if a.start_hour < b.end_hour && b.start_hour < a.end_hour {
                return Err(SCHEDULE_OVERLAP.to_string());
            }
        }
    }
    Ok(())
}

/// Every site from every rule covering this hour.
fn active_schedule_sites(schedules: &[Schedule], hour: i64) -> Vec<String> {
    schedules
        .iter()
        .filter(|s| schedule_is_active(s, hour))
        .flat_map(|s| s.sites.iter().cloned())
        .collect()
}

/// What should be blocked right now: the list a running session handed over, plus — while a scheduled
/// window is open — that window's sites and the global list.
///
/// Globals are deliberately *not* added on their own. They belong to a session or an open window, not
/// to the app merely being open. Adding them unconditionally made a fresh launch decide the block was
/// out of date, which meant a password prompt with no user action behind it — and the same prompt
/// again on every tick once it was refused.
fn wanted_domains(globals: Vec<String>, session_sites: Vec<String>, window_sites: Vec<String>) -> Vec<String> {
    let mut wanted = session_sites;
    if !window_sites.is_empty() {
        wanted.extend(globals);
        wanted.extend(window_sites);
    }
    wanted
}

/// The local hour, as last reported by the frontend with `sync_blocks`.
///
/// Rust has no local time without a timezone crate, and the close guard has to answer "is a scheduled
/// window open right now". The webview already computes the local hour for the schedule tick, so it hands
/// it over and this remembers the latest one. `-1` means the app has not synced yet, which holds nothing.
static LAST_LOCAL_HOUR: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

/// Whether the window is refused the right to close.
///
/// One function so the "no escape" promise cannot drift: a running session and an open scheduled window
/// are the same thing to a user who wants out, and closing must not be a way around either.
fn close_is_blocked(schedules: &[Schedule], hour: i64, session_end_at: Option<i64>, now: i64) -> bool {
    if session_end_at.is_some_and(|end| end > now) {
        return true;
    }
    !active_schedule_sites(schedules, hour).is_empty()
}

fn expand_sites(sites: Vec<String>) -> Vec<String> {
    let mut uniq = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in sites {
        if let Some(domain) = normalize_domain(&raw) {
            for alias in domain_aliases(&domain) {
                // `www.` is only a real host for a two-label domain; adding it to www.m.youtube.com or
                // youtu.be would be noise. This is the one place that rule lives — the privileged
                // helper renders whatever list it is handed.
                if uniq.insert(alias.clone()) {
                    out.push(alias.clone());
                }
                if alias.split('.').count() == 2 {
                    let www = format!("www.{}", alias);
                    if uniq.insert(www.clone()) {
                        out.push(www);
                    }
                }
            }
        }
    }
    out
}

// Renders the managed section. The root helper renders the same lines from the same list, so keep the
// two in step: one 127.0.0.1 and one ::1 line per domain, nothing else.
fn build_block_section(sites: &[String]) -> String {
    if sites.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    lines.push(MARKER_START.to_string());
    lines.push("# Managed by Focus Block - do not edit manually".to_string());
    for domain in sites {
        lines.push(format!("127.0.0.1 {}", domain));
        lines.push(format!("::1 {}", domain));
    }
    lines.push(MARKER_END.to_string());
    lines.join("\n") + "\n"
}

fn strip_existing_block(content: &str) -> String {
    // remove existing block between markers inclusive (handle both old BLOCKER2 and new FOCUSBLOCKER)
    let mut result = String::new();
    let mut inside = false;
    for line in content.lines() {
        // ASCII whitespace only, to match the POSIX [[:space:]] the shell renderer strips with
        let trimmed = line.trim_matches(|c: char| c.is_ascii_whitespace());
        if trimmed == MARKER_START || trimmed == MARKER_START_OLD {
            inside = true;
            continue;
        }
        if trimmed == MARKER_END || trimmed == MARKER_END_OLD {
            inside = false;
            continue;
        }
        if !inside {
            result.push_str(line);
            result.push('\n');
        }
    }
    result
}

fn is_block_active(content: &str) -> bool {
    content.contains(MARKER_START) || content.contains(MARKER_START_OLD)
}

// The helper advertises its protocol so an upgrade can keep speaking to the old one instead of
// breaking a working install: v1 accepted a file path, v2 renders the block itself.
const HELPER_V2_MARKER: &str = "# focusblock-helper v2";

/// 0 = not installed, 1 = file-path helper, 2 = renders the block from validated domains.
/// The file is root-owned inside a root-owned directory, so nobody unprivileged can rewrite it, and
/// it is the exact code that will run as root — which is why it can be trusted to report its version.
fn installed_helper_version() -> u8 {
    match fs::read_to_string(HELPER_PATH) {
        Ok(body) if body.contains(HELPER_V2_MARKER) => 2,
        Ok(_) => 1,
        Err(_) => 0,
    }
}

// Fail closed on a v1 helper. It only accepts a file path, so driving it would re-open exactly what this
// protocol closed: caller-supplied bytes copied to /etc/hosts as root. An out-of-date install therefore
// falls through to the prompted path until the user re-enables, which Settings asks them to do.
#[cfg(target_os = "linux")]
fn try_write_with_saved_auth(domains: &[String]) -> bool {
    if !is_saved_auth_active() || installed_helper_version() != 2 {
        return false;
    }
    let mut args: Vec<String> = vec!["-n".into(), HELPER_PATH.into()];
    args.extend(helper_args(domains));
    Command::new("sudo")
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn try_write_hosts_direct(content: &str) -> Result<(), String> {
    fs::write(HOSTS_PATH, content).map_err(|e| e.to_string())
}

// The managed-block renderer, as a shell script. Linux installs this exact text as the helper and the
// macOS admin command embeds it, so the two platforms cannot drift apart. It takes
// `block <domain>...` or `clear` and renders the section itself, which is what keeps caller-supplied
// bytes out of /etc/hosts.
/// Domains per write. Mirrored into the renderer below so the app and the script cannot disagree.
const MAX_DOMAINS: usize = 500;

/// The user asked for at most two daily windows, and for them not to overlap. Both limits live here so
/// the UI and the backend cannot disagree about what is valid.
const MAX_SCHEDULES: usize = 2;

const SCHEDULE_OVERLAP: &str = "scheduled blocks cannot overlap";

/// Windows carries the renderer on a command line, so the encoded form has a budget of its own. It is
/// far below the script's cap and hits first — and exceeding it used to fail silently (see the launcher).
#[cfg(target_os = "windows")]
const WINDOWS_ENCODED_BUDGET: usize = 24000;

const RENDER_SCRIPT: &str = r#"#!/bin/sh
# focusblock-helper v2
# Run as root by the app: `focusblock-apply block <domain>...` or `focusblock-apply clear`.
# The section is rendered here from validated names, so no caller-supplied bytes reach /etc/hosts.
set -eu

HOSTS=/etc/hosts
# per-run staging file: a fixed name let two concurrent runs blend their blocks into one
STAGE=$(mktemp /etc/.focusblock.hosts.XXXXXX)
trap 'rm -f "$STAGE"' EXIT INT TERM
MAX_DOMAINS=@MAX_DOMAINS@

# drop the managed region (current markers and the 0.1.1 BLOCKER2 pair), keep everything else
strip_block() {
  awk '
    /^[[:space:]]*# BEGIN FOCUSBLOCKER[[:space:]]*$/ { skip = 1; next }
    /^[[:space:]]*# BEGIN BLOCKER2[[:space:]]*$/     { skip = 1; next }
    /^[[:space:]]*# END FOCUSBLOCKER[[:space:]]*$/   { skip = 0; next }
    /^[[:space:]]*# END BLOCKER2[[:space:]]*$/       { skip = 0; next }
    !skip { print }
  ' "$HOSTS"
}

case "${1:-}" in
  block)
    shift
    [ "$#" -ge 1 ] || { echo "block needs at least one domain"; exit 1; }
    [ "$#" -le "$MAX_DOMAINS" ] || { echo "too many domains"; exit 1; }
    for d in "$@"; do
      [ -n "$d" ] || { echo "empty domain"; exit 1; }
      [ "${#d}" -le 253 ] || { echo "domain too long"; exit 1; }
      case "$d" in
        *[!a-z0-9.-]*) echo "invalid domain"; exit 1 ;;
      esac
    done
    {
      strip_block
      printf '# BEGIN FOCUSBLOCKER\n# Managed by Focus Block - do not edit manually\n'
      for d in "$@"; do
        printf '127.0.0.1 %s\n::1 %s\n' "$d" "$d"
      done
      printf '# END FOCUSBLOCKER\n'
    } > "$STAGE"
    ;;
  clear)
    strip_block > "$STAGE"
    ;;
  *)
    echo "usage: focusblock-apply block <domain>... | clear"; exit 1 ;;
esac

# same filesystem, so this swap is atomic — a crash can't leave a half-written hosts file
chown root:root "$STAGE"
chmod 644 "$STAGE"
mv -f "$STAGE" "$HOSTS"

# whichever resolver stack is present, flushed from the one place that already holds root
resolvectl flush-caches 2>/dev/null || systemd-resolve --flush-caches 2>/dev/null || true
dscacheutil -flushcache 2>/dev/null || true
killall -HUP mDNSResponder 2>/dev/null || true
echo ok
"#;

/// The renderer with its single compile-time token resolved. Every platform goes through here, so the
/// installed helper, the macOS command and the app's own idea of the cap are all the same number.
fn render_script() -> String {
    RENDER_SCRIPT.replace("@MAX_DOMAINS@", &MAX_DOMAINS.to_string())
}

/// `block <domain>…` or `clear` — the argument form every platform hands to the renderer.
fn helper_args(domains: &[String]) -> Vec<String> {
    if domains.is_empty() {
        vec!["clear".to_string()]
    } else {
        let mut args = vec!["block".to_string()];
        args.extend(domains.iter().cloned());
        args
    }
}

/// Linux: install or refresh the helper and run it, inside one authorized command. Nothing is staged.
#[cfg(target_os = "linux")]
const LINUX_INSTALL_AND_RUN: &str = r#"set -eu
body="$1"
shift
# write beside it and rename: an in-place write that fails leaves a truncated helper behind
printf '%s' "$body" > @HELPER@.new
chown root:root @HELPER@.new
chmod 755 @HELPER@.new
mv -f @HELPER@.new @HELPER@
exec @HELPER@ "$@"
"#;

/// The renderer as a self-contained command for an already-root shell, with its arguments preloaded.
#[cfg(target_os = "macos")]
fn render_command(args: &[String]) -> String {
    format!("set -- {}; {}", args.join(" "), render_script())
}

/// AppleScript string literal: backslash first, then quote, then newlines. The last one matters: the
/// renderer is multi-line, and this way correctness does not depend on AppleScript preserving literal
/// line breaks inside a string — it turns them into its own \n escape, which it parses back to LF.
#[cfg(any(target_os = "macos", test))]
fn apple_escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// Windows has no sh, so the same shape is expressed in PowerShell: strip, render, swap, flush. It
/// carries only validated domain characters and is handed over base64/UTF-16LE, so there is no quoting
/// layer left to escape out of.
#[cfg(any(target_os = "windows", test))]
fn windows_render_script(args: &[String]) -> String {
    let list = args[1..]
        .iter()
        .map(|d| format!("'{d}'"))
        .collect::<Vec<_>>()
        .join(",");
    let template = r#"$ErrorActionPreference = 'Stop'
$hosts = '@HOSTS@'
$stage = Join-Path (Split-Path $hosts) '.focusblock.hosts.new'

# keep the file's own encoding: strict UTF-8 first, Latin-1 if the bytes are not valid UTF-8, so a legacy
# comment cannot be turned into replacement characters by a write that had nothing to do with it
$bytes = [IO.File]::ReadAllBytes($hosts)
$strict = New-Object System.Text.UTF8Encoding($false, $true)
try {
  $text = $strict.GetString($bytes)
  $enc = New-Object System.Text.UTF8Encoding($false)
} catch {
  $text = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $enc = [Text.Encoding]::GetEncoding(28591)
}

$keep = New-Object 'System.Collections.Generic.List[string]'
$skip = $false
foreach ($line in ($text -split "`r`n|`n|`r")) {
  $t = $line.Trim()
  # -ceq: -eq is case-insensitive, which would treat '# begin focusblocker' as our marker
  if ($t -ceq '# BEGIN FOCUSBLOCKER' -or $t -ceq '# BEGIN BLOCKER2') { $skip = $true; continue }
  if ($t -ceq '# END FOCUSBLOCKER' -or $t -ceq '# END BLOCKER2') { $skip = $false; continue }
  if (-not $skip) { $keep.Add($line) }
}
if ('@MODE@' -eq 'block') {
  # second validation layer: the shell renderer re-checks its argv, so this one must too
  foreach ($d in @(@DOMAINS@)) {
    if ($d -notmatch '^[a-z0-9.-]+$') { throw "invalid domain: $d" }
  }
  $keep.Add('# BEGIN FOCUSBLOCKER')
  $keep.Add('# Managed by Focus Block - do not edit manually')
  foreach ($d in @(@DOMAINS@)) { $keep.Add("127.0.0.1 $d"); $keep.Add("::1 $d") }
  $keep.Add('# END FOCUSBLOCKER')
}
[IO.File]::WriteAllLines($stage, $keep, $enc)
# [IO.File]::Replace, not Move-Item: PowerShell 5.1 deletes the destination first, so a failure in between
# would leave the machine with no hosts file at all
[IO.File]::Replace($stage, $hosts, $null)
ipconfig /flushdns | Out-Null
"#;
    template
        .replace("@HOSTS@", HOSTS_PATH)
        .replace("@MODE@", args.first().map(String::as_str).unwrap_or("clear"))
        .replace("@DOMAINS@", &list)
}

/// base64 of UTF-16LE, which is what `powershell -EncodedCommand` expects.
#[cfg(any(target_os = "windows", test))]
fn base64_utf16le(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(target_os = "linux")]
fn is_saved_auth_active() -> bool {
    fs::metadata(HELPER_PATH).is_ok() && fs::metadata(SUDOERS_PATH).is_ok()
}
#[cfg(not(target_os = "linux"))]
fn is_saved_auth_active() -> bool {
    false
}

// `domains` is only consumed on Linux, where the helper takes the list instead of the rendered file.
fn write_hosts_privileged(content: &str, domains: &[String]) -> Result<(), String> {
    if try_write_hosts_direct(content).is_ok() {
        return Ok(());
    }
    // The standing authorization carries the domain list, not the rendered file, so the root side
    // validates and renders it itself and no /tmp staging happens on this path at all.
    #[cfg(target_os = "linux")]
    {
        if try_write_with_saved_auth(domains) {
            flush_dns();
            return Ok(());
        }
    }

    let args = helper_args(domains);

    // Prompted paths. Root receives validated domain names rather than a file this process can write, so
    // there is nothing to swap between the prompt and the write — the renderer runs inside the command
    // the user authorizes, on every platform. It also means the first prompted write replaces an old v1
    // helper with this one, which leaves a stale v1 sudoers rule unable to do anything: handed a file
    // path, the helper now prints usage and exits. That, not the refusal above, is what revokes it.
    #[cfg(target_os = "linux")]
    {
        let install = LINUX_INSTALL_AND_RUN.replace("@HELPER@", HELPER_PATH);
        let mut argv: Vec<String> = vec![
            // absolute: pkexec resolves a bare name against the caller's PATH
            "/bin/sh".to_string(),
            "-c".to_string(),
            install,
            "focusblock".to_string(),
            render_script(),
        ];
        argv.extend(args.iter().cloned());
        return match Command::new("pkexec").args(&argv).output() {
            Ok(out) if out.status.success() => {
                flush_dns();
                Ok(())
            }
            Ok(out) => Err(format!(
                "pkexec failed: {} | host write requires admin. Tip: enable saved authorization to skip this prompt.",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("pkexec not available: {}", e)),
        };
    }
    #[cfg(target_os = "macos")]
    {
        let command = render_command(&args);
        // a valid sudo ticket means no prompt at all; otherwise the admin dialog authorizes this command
        if let Ok(out) = Command::new("sudo").args(["-n", "sh", "-c", &command]).output() {
            if out.status.success() {
                flush_dns();
                return Ok(());
            }
        }
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            apple_escape(&command)
        );
        return match Command::new("osascript").args(["-e", &script]).output() {
            Ok(out) if out.status.success() => {
                flush_dns();
                Ok(())
            }
            Ok(out) => Err(format!(
                "macOS admin failed: {} | the whole command is authorized in one prompt",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("osascript not available: {}", e)),
        };
    }
    #[cfg(target_os = "windows")]
    {
        let encoded = base64_utf16le(&windows_render_script(&args));
        if encoded.len() > WINDOWS_ENCODED_BUDGET {
            return Err(format!(
                "block list too large for one Windows write ({} domains) — reduce the global block list",
                args.len().saturating_sub(1)
            ));
        }
        // $ErrorActionPreference is load-bearing: a cancelled UAC prompt is a non-terminating error, so
        // $p stayed $null and `exit $null` exited 0 — the app then reported success for a write that never
        // happened, and started a locked session that blocked nothing.
        let ps = format!(
            "$ErrorActionPreference = 'Stop'; $p = Start-Process -FilePath 'powershell' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{}' -Verb RunAs -Wait -PassThru; if (-not $p) {{ exit 1 }}; exit $p.ExitCode",
            encoded
        );
        return match Command::new("powershell").args(["-NoProfile", "-Command", &ps]).output() {
            Ok(out) if out.status.success() => {
                flush_dns();
                Ok(())
            }
            Ok(out) => Err(format!(
                "hosts write needs Administrator — accept the UAC prompt ({}), or run Focus Block as Administrator",
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => Err(format!("powershell not available: {}", e)),
        };
    }
}

fn flush_dns() {
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("resolvectl").args(["flush-caches"]).output();
        let _ = Command::new("systemd-resolve").args(["--flush-caches"]).output();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("dscacheutil").args(["-flushcache"]).output();
        let _ = Command::new("bash").args(["-c", "killall -HUP mDNSResponder 2>/dev/null || true"]).output();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("ipconfig").args(["/flushdns"]).output();
    }
}

fn read_hosts_content() -> Result<String, String> {
    fs::read_to_string(HOSTS_PATH).map_err(|e| e.to_string())
}

#[tauri::command]
fn activate_blocks(sites: Vec<String>) -> Result<String, String> {
    let had_input = sites.iter().any(|s| !s.trim().is_empty());
    let domains = expand_sites(sites);
    if domains.is_empty() {
        if had_input {
            // every entry failed validation: say so rather than quietly starting a session that blocks
            // nothing and reporting success
            return Err("no valid domains to block — check the site list".to_string());
        }
        // nothing asked for, so this is really a clear
        return deactivate_blocks();
    }
    if domains.len() > MAX_DOMAINS {
        return Err(format!(
            "{} domains after alias expansion, limit is {} — reduce the global block list",
            domains.len(),
            MAX_DOMAINS
        ));
    }
    let current = read_hosts_content()?;
    let stripped = strip_existing_block(&current);
    let block_section = build_block_section(&domains);
    let mut new_content = stripped;
    // ensure ends with newline
    if !new_content.ends_with('\n') && !new_content.is_empty() {
        new_content.push('\n');
    }
    new_content.push_str(&block_section);

    write_hosts_privileged(&new_content, &domains)?;
    flush_dns();
    Ok(format!("Blocked {} site(s): {}", domains.len(), domains.join(", ")))
}

#[tauri::command]
fn deactivate_blocks() -> Result<String, String> {
    let current = match read_hosts_content() {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    if !is_block_active(&current) {
        return Ok("No active blocks".to_string());
    }
    let stripped = strip_existing_block(&current);
    write_hosts_privileged(&stripped, &[])?;
    flush_dns();
    Ok("All blocks cleared".to_string())
}

#[tauri::command]
fn get_block_status() -> Result<serde_json::Value, String> {
    let content = read_hosts_content().map_err(|e| e.to_string())?;
    let active = is_block_active(&content);
    let mut sites: Vec<String> = Vec::new();
    if active {
        let mut inside = false;
        for line in content.lines() {
            let t = line.trim_matches(|c: char| c.is_ascii_whitespace());
            if t == MARKER_START || t == MARKER_START_OLD {
                inside = true;
                continue;
            }
            if t == MARKER_END || t == MARKER_END_OLD {
                inside = false;
                continue;
            }
            if inside && !t.starts_with('#') && !t.is_empty() {
                // line like "127.0.0.1 domain"
                let parts: Vec<&str> = t.split_whitespace().collect();
                if parts.len() >= 2 {
                    let domain = parts[1].trim_start_matches("www.").to_string();
                    if !sites.contains(&domain) {
                        sites.push(domain);
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({
        "active": active,
        "sites": sites,
        "hosts_path": HOSTS_PATH
    }))
}

#[tauri::command]
fn preview_hosts() -> Result<String, String> {
    read_hosts_content()
}

#[tauri::command]
fn check_saved_auth() -> Result<serde_json::Value, String> {
    let helper_version = installed_helper_version();
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        // "enabled" means the passwordless path actually works. File presence alone used to report green
        // while every write still prompted (a v1 helper, or a v2 helper whose rule does not match).
        "enabled": is_saved_auth_active() && helper_version == 2,
        "helper_version": helper_version,
    }))
}

// The username lands in a sudoers rule, so it has to be a plain name: a stray space or newline is a
// syntax error, and a bad one stops sudo working for the whole machine. Refuse rather than guess —
// guessing (the old default) would write a rule for whoever that name happens to be.
#[cfg(target_os = "linux")]
fn current_username() -> Result<String, String> {
    let user = std::env::var("SUDO_USER")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|u| !u.is_empty() && u != "root")
        .or_else(|| {
            Command::new("id")
                .args(["-un"])
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                })
        })
        .unwrap_or_default();
    if user.is_empty() {
        return Err("could not determine the current username — refusing to write a sudoers rule".to_string());
    }
    // ALL is a sudoers keyword, not a name: `ALL ALL=(ALL) NOPASSWD: …` parses fine and grants every
    // local user, so it must never get through here.
    if user.eq_ignore_ascii_case("all") {
        return Err("refusing to write a sudoers rule with a reserved username".to_string());
    }
    if !user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(format!(
            "refusing to write a sudoers rule for unexpected username {:?}",
            user
        ));
    }
    Ok(user)
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn enable_saved_auth() -> Result<String, String> {
    // helper script validates tmp and does cp + flush
    // Installed verbatim; the identical text is embedded in the macOS admin command, so root renders
    // the block on every platform and never copies a file this process can still write.
    let helper_content = render_script();
    let user = current_username()?;

    // The helper body and the username reach root as argv, never as files. Staging them under /tmp
    // meant anything running as this user could rewrite both while the password prompt was open, and
    // get its own helper body (arbitrary code as root) and sudoers rule (root, no password) installed.
    let script = r#"set -eu
helper_body="$1"
user="$2"

if [ -z "$user" ]; then echo "invalid username"; exit 1; fi
case "$user" in
  *[!A-Za-z0-9._-]*) echo "invalid username"; exit 1 ;;
esac
if ! command -v visudo >/dev/null 2>&1; then
  echo "visudo not found; refusing to install a sudoers rule"
  exit 1
fi

# stage the rule outside sudoers.d, validate it, then move it in atomically: a rule that does not
# parse makes sudo refuse to run at all, so it must never land in that directory untested
printf '%s ALL=(ALL) NOPASSWD: @HELPER@ block *, @HELPER@ clear\n' "$user" > /etc/.focusblock.sudoers.new
chown root:root /etc/.focusblock.sudoers.new
chmod 440 /etc/.focusblock.sudoers.new
if ! visudo -cf /etc/.focusblock.sudoers.new >/dev/null 2>&1; then
  rm -f /etc/.focusblock.sudoers.new
  echo "generated sudoers rule failed validation; nothing installed"
  exit 1
fi

# only now touch the live files: helper first, rule second, so either both land or neither does
printf '%s' "$helper_body" > @HELPER@.new
chown root:root @HELPER@.new
chmod 755 @HELPER@.new
mv -f @HELPER@.new @HELPER@
mv -f /etc/.focusblock.sudoers.new @SUDOERS@

# legacy 0.1.1 midnight reset, if an older install left one behind
rm -f @CRON@
echo "ok"
"#
    .replace("@HELPER@", HELPER_PATH)
    .replace("@SUDOERS@", SUDOERS_PATH)
    .replace("@CRON@", CRON_PATH);

    let out = Command::new("pkexec")
        .args([
            "sh",
            "-c",
            script.as_str(),
            "focusblock-enable",
            &helper_content,
            user.as_str(),
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        return Err(format!("setup failed: {} {}", stderr.trim(), stdout.trim()));
    }
    Ok("Saved authorization enabled: no more password prompts — stays on until you disable it".to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn enable_saved_auth() -> Result<String, String> {
    Err("Saved authorization is Linux only — macOS/Windows prompt each time".to_string())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn disable_saved_auth() -> Result<String, String> {
    let script = format!("rm -f {} {} {}", HELPER_PATH, SUDOERS_PATH, CRON_PATH);
    let out = Command::new("pkexec")
        .args(["sh", "-c", &script])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("disable failed: {}", stderr.trim()));
    }
    // fallback direct removal if pkexec not needed (already root?)
    let _ = fs::remove_file(HELPER_PATH);
    let _ = fs::remove_file(SUDOERS_PATH);
    let _ = fs::remove_file(CRON_PATH);
    Ok("Saved authorization disabled: every Start and End will ask for a password".to_string())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn disable_saved_auth() -> Result<String, String> {
    Err("Saved authorization is Linux only".to_string())
}

// --- sqlite commands ---
#[tauri::command]
fn get_todos(handle: tauri::AppHandle) -> Result<Vec<Todo>, String> {
    let conn = get_conn(&handle)?;
    let mut stmt = conn
        .prepare("SELECT id, title, duration_minutes, blocked_sites, created_at FROM todos ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let blocked_json: String = row.get(3)?;
            let sites: Vec<String> =
                serde_json::from_str(&blocked_json).unwrap_or_default();
            Ok(Todo {
                id: row.get(0)?,
                title: row.get(1)?,
                duration_minutes: row.get(2)?,
                blocked_sites: sites,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn sync_todos(handle: tauri::AppHandle, todos: Vec<Todo>) -> Result<(), String> {
    let mut conn = get_conn(&handle)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // collect ids for delete-missing
    let ids: Vec<String> = todos.iter().map(|t| t.id.clone()).collect();
    if ids.is_empty() {
        tx.execute("DELETE FROM todos", []).map_err(|e| e.to_string())?;
    } else {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("DELETE FROM todos WHERE id NOT IN ({})", placeholders);
        let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        tx.execute(&sql, params.as_slice())
            .map_err(|e| e.to_string())?;
    }
    for t in &todos {
        let blocked_json = serde_json::to_string(&t.blocked_sites).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO todos (id, title, duration_minutes, blocked_sites, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![t.id, t.title, t.duration_minutes, blocked_json, t.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn read_global_blocks(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT site FROM global_blocks ORDER BY site")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Whether a session is running right now, by the same test the close guard uses.
fn session_is_running(conn: &rusqlite::Connection) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.query_row("SELECT end_at FROM active_session LIMIT 1", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|end| end > now)
    .unwrap_or(false)
}

/// While a session runs, the global list may only **grow**.
///
/// An addition makes the block stricter, so it cannot be a way out of a session; removing one would weaken
/// a session the user has committed to, so it waits until the timer ends. Pure, so the policy is testable
/// without a database — and enforced here rather than only in the UI, which is cosmetic.
fn check_global_change(stored: &[String], proposed: &[String], session_running: bool) -> Result<(), String> {
    if !session_running {
        return Ok(());
    }
    match stored.iter().find(|site| !proposed.contains(site)) {
        Some(site) => Err(format!(
            "{site} is blocked for the rest of this session — removing it waits until the timer ends"
        )),
        None => Ok(()),
    }
}

fn read_schedules(conn: &rusqlite::Connection) -> Result<Vec<Schedule>, String> {
    let mut stmt = conn
        .prepare("SELECT id, start_hour, end_hour, sites, created_at FROM schedules ORDER BY start_hour")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let sites_json: String = row.get(3)?;
            Ok(Schedule {
                id: row.get(0)?,
                start_hour: row.get(1)?,
                end_hour: row.get(2)?,
                sites: serde_json::from_str(&sites_json).unwrap_or_default(),
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn get_global_blocks(handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let conn = get_conn(&handle)?;
    read_global_blocks(&conn)
}

#[tauri::command]
fn set_global_blocks(handle: tauri::AppHandle, sites: Vec<String>) -> Result<(), String> {
    let mut conn = get_conn(&handle)?;
    // additions are always fine; a removal waits for the session to end
    let stored = read_global_blocks(&conn)?;
    check_global_change(&stored, &sites, session_is_running(&conn))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM global_blocks", [])
        .map_err(|e| e.to_string())?;
    for s in &sites {
        tx.execute(
            "INSERT OR IGNORE INTO global_blocks (site) VALUES (?1)",
            params![s],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// --- scheduled daily blocks ---
#[tauri::command]
fn get_schedules(handle: tauri::AppHandle) -> Result<Vec<Schedule>, String> {
    let conn = get_conn(&handle)?;
    read_schedules(&conn)
}

#[tauri::command]
fn save_schedules(handle: tauri::AppHandle, schedules: Vec<Schedule>) -> Result<(), String> {
    validate_schedules(&schedules)?;
    let mut conn = get_conn(&handle)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM schedules", [])
        .map_err(|e| e.to_string())?;
    for s in &schedules {
        let sites_json = serde_json::to_string(&s.sites).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO schedules (id, start_hour, end_hour, sites, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![s.id, s.start_hour, s.end_hour, sites_json, s.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Block exactly the union of the global blocks, the running session's sites and every scheduled rule
/// whose window covers `hour`. Writes only when the file would actually change, so the periodic tick is
/// free and never asks for a password it does not need.
#[tauri::command]
fn sync_blocks(
    handle: tauri::AppHandle,
    hour: i64,
    session_sites: Vec<String>,
    dry_run: Option<bool>,
) -> Result<serde_json::Value, String> {
    // the close guard reads this; see LAST_LOCAL_HOUR
    LAST_LOCAL_HOUR.store(hour, std::sync::atomic::Ordering::Relaxed);
    let conn = get_conn(&handle)?;
    let schedules = read_schedules(&conn)?;
    let active_ids: Vec<String> = schedules
        .iter()
        .filter(|s| schedule_is_active(s, hour))
        .map(|s| s.id.clone())
        .collect();

    let window_sites = active_schedule_sites(&schedules, hour);
    let domains = expand_sites(wanted_domains(read_global_blocks(&conn)?, session_sites, window_sites));

    // Build the file in memory and compare: if it already says this, there is nothing to do
    let current = read_hosts_content()?;
    let mut new_content = strip_existing_block(&current);
    if !new_content.ends_with('\n') && !new_content.is_empty() {
        new_content.push('\n');
    }
    new_content.push_str(&build_block_section(&domains));

    let changed = new_content != current;
    // A dry run reports what a write would do without asking anybody for a password, so a caller that
    // cannot write unattended can offer one click instead of prompting on every tick.
    if changed && !dry_run.unwrap_or(false) {
        write_hosts_privileged(&new_content, &domains)?;
        flush_dns();
    }
    Ok(serde_json::json!({
        "changed": changed,
        "blocked": domains.len(),
        "activeRuleIds": active_ids,
    }))
}

#[tauri::command]
fn get_active_session(handle: tauri::AppHandle) -> Result<Option<ActiveSession>, String> {
    let conn = get_conn(&handle)?;
    let mut stmt = conn
        .prepare("SELECT todo_id, start_at, end_at, duration_seconds FROM active_session LIMIT 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(ActiveSession {
            todo_id: row.get(0).map_err(|e| e.to_string())?,
            start_at: row.get(1).map_err(|e| e.to_string())?,
            end_at: row.get(2).map_err(|e| e.to_string())?,
            duration_seconds: row.get(3).map_err(|e| e.to_string())?,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn save_active_session(
    handle: tauri::AppHandle,
    session: ActiveSession,
) -> Result<(), String> {
    let conn = get_conn(&handle)?;
    conn.execute("DELETE FROM active_session", [])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO active_session (todo_id, start_at, end_at, duration_seconds) VALUES (?1, ?2, ?3, ?4)",
        params![session.todo_id, session.start_at, session.end_at, session.duration_seconds],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn clear_active_session(handle: tauri::AppHandle) -> Result<(), String> {
    let conn = get_conn(&handle)?;
    conn.execute("DELETE FROM active_session", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ponytail: flat active_session table, add history table (sessions_history) if stats/streaks needed

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // ensure db exists on startup (ponytail: WAL + 4 tables, no migration yet)
            let handle = app.handle().clone();
            let _ = get_conn(&handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            activate_blocks,
            deactivate_blocks,
            get_block_status,
            preview_hosts,
            check_saved_auth,
            enable_saved_auth,
            disable_saved_auth,
            get_todos,
            sync_todos,
            get_global_blocks,
            set_global_blocks,
            get_schedules,
            save_schedules,
            sync_blocks,
            get_active_session,
            save_active_session,
            clear_active_session
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app_handle = _window.app_handle();
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let hour = LAST_LOCAL_HOUR.load(std::sync::atomic::Ordering::Relaxed);

                // hard block: a running session, or an open scheduled window, means no escape
                let (mut session_end_at, mut schedules) = (None, Vec::new());
                if let Ok(conn) = get_conn(&app_handle) {
                    session_end_at = conn
                        .query_row("SELECT end_at FROM active_session LIMIT 1", [], |row| row.get(0))
                        .ok();
                    schedules = read_schedules(&conn).unwrap_or_default();
                }
                if close_is_blocked(&schedules, hour, session_end_at, now) {
                    api.prevent_close();
                    return;
                }

                // best-effort hosts cleanup on close — deactivate_blocks owns that logic, including
                // which helper protocol is installed, so there is only one implementation to trust
                let _ = deactivate_blocks();
                // clear active_session so next launch doesn't resume with mismatched hosts
                if let Ok(conn) = get_conn(&app_handle) {
                    let _ = conn.execute("DELETE FROM active_session", []);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(id: &str, start_hour: i64, end_hour: i64, sites: &[&str]) -> Schedule {
        Schedule {
            id: id.to_string(),
            start_hour,
            end_hour,
            sites: sites.iter().map(|s| s.to_string()).collect(),
            created_at: 0,
        }
    }

    // ── domain names ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn normalize_drops_the_noise_a_person_pastes() {
        assert_eq!(
            normalize_domain("  HTTPS://WWW.YouTube.com/watch?v=x  ").as_deref(),
            Some("youtube.com")
        );
        assert_eq!(normalize_domain("x.com:443").as_deref(), Some("x.com"));
        assert_eq!(normalize_domain("x.com.").as_deref(), Some("x.com"));
        assert_eq!(normalize_domain("www.x.com").as_deref(), Some("x.com"));
        assert_eq!(normalize_domain("sub.x.com").as_deref(), Some("sub.x.com"));

        for junk in ["", "   ", "notadomain", ".", "..", "a b.com", "a;b.com", "a$b.com", "*.com", "例え.jp"] {
            assert_eq!(normalize_domain(junk), None, "{junk:?} should not be a domain");
        }
    }

    /// The invariant the whole privilege design rests on: a name is handed to root as a name, so
    /// nothing it can contain may end the hosts line or start a new directive.
    #[test]
    fn nothing_that_survives_normalization_can_break_out_of_a_hosts_line() {
        let hostile = [
            "a.com",
            "a;rm -rf /.com",
            "a\n127.0.0.1 evil.com",
            "a\rb.com",
            "a\tb.com",
            "a b.com",
            "a#comment.com",
            "a/b.com",
            "a\\b.com",
            "a\"b.com",
            "a'b.com",
            "a`id`.com",
            "a$(id).com",
            "a|b.com",
            "a&&b.com",
            "a..b.com",
            "a-.com",
        ];
        for raw in hostile {
            if let Some(domain) = normalize_domain(raw) {
                assert!(!domain.is_empty(), "{raw:?} produced an empty name");
                assert!(
                    domain
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-'),
                    "{raw:?} produced {domain:?}"
                );
                assert!(
                    !domain.chars().any(|c| " \t\r\n#;\\/:\"'`$|&><()".contains(c)),
                    "{raw:?} produced {domain:?}"
                );
            }
        }
    }

    #[test]
    fn aliases_expand_and_www_is_only_added_to_two_label_names() {
        assert_eq!(
            expand_sites(vec!["youtube.com".into()]),
            vec![
                "youtube.com",
                "www.youtube.com",
                "youtu.be",
                "www.youtu.be",
                "m.youtube.com",
                "youtube-nocookie.com",
                "www.youtube-nocookie.com",
            ]
        );
        // asking for an alias and for the site it points at is the same request
        assert_eq!(
            expand_sites(vec!["x.com".into()]),
            expand_sites(vec!["twitter.com".into(), "t.co".into()])
        );
        // three labels: `www.m.youtube.com` is not a host anyone visits, so it is not invented
        assert_eq!(expand_sites(vec!["m.youtube.com".into()]), vec!["m.youtube.com"]);
        assert!(expand_sites(vec!["nope".into(), "  ".into(), "bad name.com".into()]).is_empty());
    }

    // ── the managed section ─────────────────────────────────────────────────────────────────────

    const STOCK: &str = "127.0.0.1 localhost\n# my own comment\n10.0.0.1 keep.me\n";
    const STOCK_WITH_LEGACY: &str =
        "127.0.0.1 localhost\n# my own comment\n# BEGIN BLOCKER2\n127.0.0.1 stale.com\n# END BLOCKER2\n10.0.0.1 keep.me\n";

    #[test]
    fn the_section_lists_both_families_once_per_domain() {
        let section = build_block_section(&["a.com".into(), "b.com".into()]);
        assert!(section.starts_with(MARKER_START));
        assert!(section.ends_with(&format!("{MARKER_END}\n")));
        for d in ["a.com", "b.com"] {
            assert_eq!(section.matches(&format!("127.0.0.1 {d}\n")).count(), 1, "{d}");
            assert_eq!(section.matches(&format!("::1 {d}\n")).count(), 1, "{d}");
        }
        // no domains, no section: an empty block would still mark the file as managed
        assert_eq!(build_block_section(&[]), "");
    }

    #[test]
    fn rebuilding_the_same_block_is_a_no_op() {
        // every write is strip-then-render, and the app skips the privileged write when the result is
        // byte for byte what is already on disk, so a repeat has to be identical
        let once = format!("{STOCK}{}", build_block_section(&["a.com".into()]));
        let twice = format!(
            "{}{}",
            strip_existing_block(&once),
            build_block_section(&["a.com".into()])
        );
        assert_eq!(once, twice);
        assert_eq!(strip_existing_block(&once), STOCK);
    }

    #[test]
    fn stripping_leaves_every_other_line_alone() {
        assert!(is_block_active(STOCK_WITH_LEGACY));
        assert!(!is_block_active(STOCK));
        // 0.1.1's markers go too, so an upgrade cleans up after itself
        assert_eq!(strip_existing_block(STOCK_WITH_LEGACY), STOCK);
        // markers are matched with surrounding whitespace, like the awk in the shell renderer
        assert_eq!(
            strip_existing_block("  # BEGIN FOCUSBLOCKER\nx\n\t# END FOCUSBLOCKER  \nkeep\n"),
            "keep\n"
        );
    }

    // ── schedules ───────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_window_runs_from_its_start_hour_up_to_its_end_hour() {
        let rule = schedule("a", 7, 10, &[]);
        // 7 to 10 covers 07:00 through 09:59; 10:00 is already released
        for hour in [7, 8, 9] {
            assert!(schedule_is_active(&rule, hour), "{hour}:00 should be inside 7-10");
        }
        for hour in [0, 6, 10, 11, 23] {
            assert!(!schedule_is_active(&rule, hour), "{hour}:00 should be outside 7-10");
        }
        let all_day = schedule("b", 0, 24, &[]);
        assert!(schedule_is_active(&all_day, 0));
        assert!(schedule_is_active(&all_day, 23));
        assert!(!schedule_is_active(&all_day, 24));
    }

    #[test]
    fn invalid_schedules_are_rejected() {
        assert!(validate_schedules(&[]).is_ok());
        // touching windows are fine: one releases at 10:00 and the next starts there
        assert!(validate_schedules(&[schedule("a", 7, 10, &[]), schedule("b", 10, 12, &[])]).is_ok());
        assert_eq!(
            validate_schedules(&[schedule("a", 7, 10, &[]), schedule("b", 9, 12, &[])]).unwrap_err(),
            SCHEDULE_OVERLAP
        );
        // contained, not just crossing
        assert_eq!(
            validate_schedules(&[schedule("a", 7, 12, &[]), schedule("b", 8, 9, &[])]).unwrap_err(),
            SCHEDULE_OVERLAP
        );
        assert!(validate_schedules(&[schedule("a", 10, 7, &[])]).is_err());
        assert!(validate_schedules(&[schedule("a", 7, 7, &[])]).is_err());
        assert!(validate_schedules(&[schedule("a", -1, 7, &[])]).is_err());
        assert!(validate_schedules(&[schedule("a", 0, 25, &[])]).is_err());
        let three = vec![
            schedule("a", 1, 2, &[]),
            schedule("b", 3, 4, &[]),
            schedule("c", 5, 6, &[]),
        ];
        assert!(validate_schedules(&three).is_err());
    }

    #[test]
    fn only_the_windows_covering_now_contribute_sites() {
        let rules = vec![
            schedule("morning", 7, 10, &["x.com", "y.com"]),
            schedule("evening", 19, 22, &["z.com"]),
        ];
        assert_eq!(active_schedule_sites(&rules, 8), vec!["x.com", "y.com"]);
        assert_eq!(active_schedule_sites(&rules, 20), vec!["z.com"]);
        assert!(active_schedule_sites(&rules, 12).is_empty());
    }

    #[test]
    fn nothing_is_blocked_just_because_the_app_is_open() {
        // The regression this exists for: the global list used to be added unconditionally, so opening
        // the app decided /etc/hosts was out of date and asked for a password before the user had done
        // anything — then asked again on every 30s tick that was refused.
        let domains = expand_sites(wanted_domains(
            vec!["mangadex.org".into(), "x.com".into()],
            vec![],
            vec![],
        ));
        assert!(domains.is_empty(), "opening the app must not want to block anything");

        // and the writer would find nothing to change, which is what decides whether a write happens
        let stock = "127.0.0.1 localhost\n";
        let mut new_content = strip_existing_block(stock);
        if !new_content.ends_with('\n') && !new_content.is_empty() {
            new_content.push('\n');
        }
        new_content.push_str(&build_block_section(&domains));
        assert_eq!(new_content, stock, "a fresh launch has nothing to write");
    }

    #[test]
    fn a_session_brings_its_list_and_a_window_brings_the_globals_too() {
        let globals = vec!["reddit.com".to_string()];

        // the frontend merges the global list into a running session's list, so it passes through
        assert_eq!(
            wanted_domains(globals.clone(), vec!["reddit.com".into(), "x.com".into()], vec![]),
            vec!["reddit.com", "x.com"]
        );

        // a window has no session behind it, so its own sites and the globals are both added
        assert_eq!(
            wanted_domains(globals.clone(), vec![], vec!["youtube.com".into()]),
            vec!["reddit.com", "youtube.com"]
        );

        // a window open during a session: union of both, with the duplicate left for expand_sites to drop
        let mut both = wanted_domains(globals, vec!["reddit.com".into(), "x.com".into()], vec!["youtube.com".into()]);
        both.sort();
        both.dedup();
        assert_eq!(both, vec!["reddit.com", "x.com", "youtube.com"]);
    }

    #[test]
    fn a_session_can_gain_global_blocks_but_not_lose_them() {
        let stored: Vec<String> = vec!["reddit.com".into(), "x.com".into()];
        let to = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // no session: anything goes, including clearing the list
        assert!(check_global_change(&stored, &[], false).is_ok());

        // a session: adding is fine, in any order — it only makes the block stricter
        assert!(check_global_change(&stored, &to(&["reddit.com", "x.com", "youtube.com"]), true).is_ok());
        assert!(check_global_change(&stored, &to(&["x.com", "reddit.com"]), true).is_ok());
        assert!(check_global_change(&to(&[]), &to(&["youtube.com"]), true).is_ok());

        // a session: dropping one is refused, and the message names the site
        let err = check_global_change(&stored, &to(&["reddit.com"]), true).unwrap_err();
        assert!(err.starts_with("x.com "), "unexpected message: {err}");
        assert!(check_global_change(&stored, &[], true).is_err());
    }

    #[test]
    fn closing_is_refused_while_a_session_or_a_window_is_open() {
        let rules = vec![schedule("work", 7, 10, &["x.com"])];
        let now = 1_000_000;

        // a running session blocks closing, as it always has
        assert!(close_is_blocked(&[], 12, Some(now + 60_000), now));
        // and so does a scheduled window, with no session behind it: closing is not a way out of one
        assert!(close_is_blocked(&rules, 8, None, now));
        // both at once
        assert!(close_is_blocked(&rules, 8, Some(now + 60_000), now));

        // nothing holds the window once the session has expired and no rule covers the hour
        assert!(!close_is_blocked(&rules, 10, None, now));
        assert!(!close_is_blocked(&rules, 12, Some(now - 1), now));
        assert!(!close_is_blocked(&rules, 6, None, now));
        // an unknown local hour (-1, before the first sync) holds nothing rather than trapping the user
        assert!(!close_is_blocked(&rules, -1, None, now));
    }

    // ── what gets handed to root ────────────────────────────────────────────────────────────────

    #[test]
    fn the_script_is_rendered_with_its_cap_resolved() {
        let script = render_script();
        assert!(script.starts_with("#!/bin/sh"));
        assert!(script.contains(HELPER_V2_MARKER), "the installed helper has to advertise v2");
        assert!(!script.contains("@MAX_DOMAINS@"), "a token left in would be a syntax error");
        assert!(script.contains(&format!("MAX_DOMAINS={MAX_DOMAINS}")));
        assert!(script.contains("mv -f \"$STAGE\" \"$HOSTS\""), "the swap has to stay atomic");
    }

    #[test]
    fn helper_arguments_are_a_mode_and_its_names() {
        assert_eq!(helper_args(&[]), vec!["clear".to_string()]);
        assert_eq!(
            helper_args(&["a.com".into()]),
            vec!["block".to_string(), "a.com".to_string()]
        );
        // an empty list must never render as `block` with no names: the helper exits 1 there
        assert_ne!(helper_args(&[])[0], "block");
    }

    // ── the renderer the machine actually runs ──────────────────────────────────────────────────
    // The steps below run the real text the app installs and then hands to root, with its two
    // absolute paths pointed at a sandbox. Every rewrite is asserted, because a silent miss would
    // aim `mv` at this machine's own /etc/hosts.

    #[cfg(unix)]
    mod shell {
        use super::*;
        use std::fs;
        use std::path::PathBuf;
        use std::process::{Command, Output};

        struct Sandbox {
            dir: PathBuf,
            hosts: PathBuf,
            script: PathBuf,
        }

        impl Sandbox {
            fn new(name: &str, hosts_content: &str) -> Sandbox {
                let dir = std::env::temp_dir().join(format!("focusblock-{}-{name}", std::process::id()));
                let _ = fs::remove_dir_all(&dir);
                fs::create_dir_all(&dir).expect("sandbox dir");
                let hosts = dir.join("hosts");
                fs::write(&hosts, hosts_content).expect("hosts");
                let script = dir.join("apply.sh");

                let text = render_script()
                    .replace("HOSTS=/etc/hosts", &format!("HOSTS={}", hosts.display()))
                    .replace(
                        "mktemp /etc/.focusblock.hosts.XXXXXX",
                        &format!("mktemp {}/.focusblock.hosts.XXXXXX", dir.display()),
                    )
                    // chown would fail for a non-root test user, and `set -eu` would then abort before
                    // the swap this test is about. Installing the helper owns that job anyway.
                    .replace("chown root:root \"$STAGE\"", ": # chown belongs to the installer");
                // the header comment may still say /etc/hosts in prose; what must not survive is a
                // rewrite that leaves a *live* path behind, because that is where `mv` would point
                assert!(
                    !text.contains("HOSTS=/etc/hosts") && !text.contains("mktemp /etc/"),
                    "sandbox rewrite missed a live path"
                );
                assert!(!text.contains("chown root:root"), "sandbox rewrite missed the chown");
                fs::write(&script, text).expect("script");

                Sandbox { dir, hosts, script }
            }

            fn run(&self, args: &[&str]) -> Output {
                Command::new("sh")
                    .arg(&self.script)
                    .args(args)
                    .output()
                    .expect("run the renderer")
            }

            fn hosts(&self) -> String {
                fs::read_to_string(&self.hosts).expect("read hosts")
            }

            /// Whatever the script did, no staging file may survive: that is what the trap is for.
            fn assert_no_leftovers(&self) {
                let leftovers: Vec<String> = fs::read_dir(&self.dir)
                    .expect("read sandbox")
                    .filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| n.starts_with(".focusblock.hosts."))
                    .collect();
                assert!(leftovers.is_empty(), "staging files left behind: {leftovers:?}");
            }
        }

        #[test]
        fn block_rewrites_the_managed_section_and_nothing_else() {
            let sandbox = Sandbox::new("block", STOCK_WITH_LEGACY);
            let out = sandbox.run(&["block", "a.com", "b.com"]);
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");

            let text = sandbox.hosts();
            assert!(text.contains("127.0.0.1 localhost\n"), "the file's own lines must survive");
            assert!(text.contains("10.0.0.1 keep.me\n"));
            assert!(!text.contains("stale.com"), "the 0.1.1 block must be gone");
            assert_eq!(text.matches(MARKER_START).count(), 1);
            assert_eq!(text.matches(MARKER_END).count(), 1);
            assert!(text.find("keep.me").unwrap() < text.find(MARKER_START).unwrap());
            for d in ["a.com", "b.com"] {
                assert_eq!(text.matches(&format!("127.0.0.1 {d}\n")).count(), 1, "{d}");
                assert_eq!(text.matches(&format!("::1 {d}\n")).count(), 1, "{d}");
            }
            sandbox.assert_no_leftovers();
        }

        #[test]
        fn clear_takes_the_section_out_and_leaves_the_rest() {
            let sandbox = Sandbox::new("clear", STOCK);
            assert!(sandbox.run(&["block", "a.com"]).status.success());
            let out = sandbox.run(&["clear"]);
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            assert_eq!(sandbox.hosts(), STOCK, "clear should give the file back unchanged");
            assert!(!is_block_active(&sandbox.hosts()));
            sandbox.assert_no_leftovers();
        }

        #[test]
        fn clear_also_removes_a_leftover_0_1_1_block() {
            let sandbox = Sandbox::new("legacy", STOCK_WITH_LEGACY);
            assert!(sandbox.run(&["clear"]).status.success());
            assert_eq!(sandbox.hosts(), STOCK);
        }

        #[test]
        fn a_hostile_name_is_refused_before_the_file_is_touched() {
            let sandbox = Sandbox::new("hostile", STOCK);
            for bad in [
                "a.com; rm -rf /",
                "a.com$(id)",
                "a.com`id`",
                "a b.com",
                "A.com",
                "a.com\n127.0.0.1 evil.com",
                "",
            ] {
                let out = sandbox.run(&["block", bad]);
                assert!(!out.status.success(), "{bad:?} was accepted");
                assert_eq!(sandbox.hosts(), STOCK, "{bad:?} changed the file");
            }
            // the mode itself is a closed set, and `block` with no names is not a call
            for args in [vec!["install-malware"], vec!["block"], vec![]] {
                assert!(!sandbox.run(&args).status.success(), "{args:?} was accepted");
                assert_eq!(sandbox.hosts(), STOCK);
            }
            sandbox.assert_no_leftovers();
        }

        /// Junk that cannot break the line is written as it is. `-x.com` is not a real host and
        /// `a..b.com` is not either, but both are inert text on a line we own, and the app's own
        /// normalization accepts them for the same reason. The line above is the one that matters:
        /// nothing may get through that could end the line or start a new directive. Rejecting these
        /// would mean a second copy of the rule in the renderer for no security gain.
        #[test]
        fn junk_that_cannot_break_a_line_is_written_as_it_is() {
            let sandbox = Sandbox::new("junk", STOCK);
            assert!(sandbox.run(&["block", "-x.com", "a..b.com"]).status.success());
            let text = sandbox.hosts();
            assert!(text.contains("127.0.0.1 -x.com\n"));
            assert!(text.contains("::1 a..b.com\n"));
            assert_eq!(text.matches(MARKER_START).count(), 1);
            // localhost plus the two names, so nothing extra was written on the way
            assert_eq!(text.matches("127.0.0.1 ").count(), 3);
            sandbox.assert_no_leftovers();
        }

        #[test]
        fn the_caps_are_the_ones_the_app_applies() {
            let sandbox = Sandbox::new("caps", STOCK);
            let at_cap: Vec<String> = (0..MAX_DOMAINS).map(|i| format!("d{i}.com")).collect();
            let args: Vec<&str> = at_cap.iter().map(String::as_str).collect();
            let out = Command::new("sh")
                .arg(&sandbox.script)
                .arg("block")
                .args(&args)
                .output()
                .expect("run");
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let text = sandbox.hosts();
            assert_eq!(text.matches("127.0.0.1 d").count(), MAX_DOMAINS);

            let over: Vec<String> = (0..=MAX_DOMAINS).map(|i| format!("d{i}.com")).collect();
            let over_args: Vec<&str> = over.iter().map(String::as_str).collect();
            let out = Command::new("sh")
                .arg(&sandbox.script)
                .arg("block")
                .args(&over_args)
                .output()
                .expect("run");
            assert!(!out.status.success(), "one over the cap must be refused");
            assert_eq!(sandbox.hosts(), text, "a refused run must not change the file");

            // 254 characters is one over the length a DNS name may have
            let long = format!("{}.com", "a".repeat(250));
            assert!(!sandbox.run(&["block", long.as_str()]).status.success());
            sandbox.assert_no_leftovers();
        }

        #[test]
        fn two_runs_at_once_cannot_blend_into_one_block() {
            // regression: with a fixed staging name, a run could render from a half-written file and
            // end up with domains from both runs inside one managed section
            let sandbox = Sandbox::new("concurrent", STOCK);
            let first: Vec<String> = (0..200).map(|i| format!("a{i}.com")).collect();
            let second: Vec<String> = (0..200).map(|i| format!("b{i}.com")).collect();
            let a = Command::new("sh")
                .arg(&sandbox.script)
                .arg("block")
                .args(&first)
                .spawn()
                .expect("spawn");
            let b = Command::new("sh")
                .arg(&sandbox.script)
                .arg("block")
                .args(&second)
                .spawn()
                .expect("spawn");
            assert!(a.wait_with_output().expect("wait").status.success());
            assert!(b.wait_with_output().expect("wait").status.success());

            let text = sandbox.hosts();
            assert_eq!(text.matches(MARKER_START).count(), 1, "blocks were blended:\n{text}");
            assert_eq!(text.matches(MARKER_END).count(), 1);
            assert!(text.contains("127.0.0.1 localhost\n"), "the file's own lines must survive");
            let from_first = (0..200)
                .filter(|i| text.contains(&format!("127.0.0.1 a{i}.com\n")))
                .count();
            let from_second = (0..200)
                .filter(|i| text.contains(&format!("127.0.0.1 b{i}.com\n")))
                .count();
            assert!(
                (from_first == 200 && from_second == 0) || (from_first == 0 && from_second == 200),
                "the file holds a mix: {from_first} from one run, {from_second} from the other"
            );
            sandbox.assert_no_leftovers();
        }
    }

    // ── the other two platforms ─────────────────────────────────────────────────────────────────
    // These renderers are gated to their own OS in a normal build; `test` includes them so their text
    // can be checked on any machine instead of only on a runner nobody can debug.

    #[cfg(any(target_os = "macos", test))]
    mod apple {
        use super::*;

        #[test]
        fn escaping_survives_a_quote_a_backslash_and_a_newline() {
            assert_eq!(apple_escape("plain"), "plain");
            assert_eq!(apple_escape("a\"b"), "a\\\"b");
            assert_eq!(apple_escape("a\\b"), "a\\\\b");
            assert_eq!(apple_escape("a\nb"), "a\\nb");
            // order matters: quotes are escaped after backslashes, or the backslash a quote gains would
            // be doubled and the quote would close the AppleScript string early
            assert_eq!(apple_escape("\\\""), "\\\\\\\"");
        }

        #[test]
        fn what_applescript_parses_back_is_the_script_we_meant() {
            let original = render_script();
            let escaped = apple_escape(&original);
            assert!(!escaped.contains('\n'), "a raw newline would end the command");

            let mut unescaped = String::new();
            let mut chars = escaped.chars();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    match chars.next() {
                        Some('n') => unescaped.push('\n'),
                        Some(other) => unescaped.push(other),
                        None => panic!("dangling backslash"),
                    }
                } else {
                    unescaped.push(c);
                }
            }
            assert_eq!(unescaped, original, "the round trip has to give the script back");
        }
    }

    #[cfg(any(target_os = "windows", test))]
    mod powershell {
        use super::*;

        #[test]
        fn no_template_token_survives() {
            let text = windows_render_script(&["block".into(), "a.com".into(), "b.com".into()]);
            for token in ["@HOSTS@", "@MODE@", "@DOMAINS@"] {
                assert!(!text.contains(token), "{token} was left in the script");
            }
            assert!(text.contains("$ErrorActionPreference = 'Stop'"), "a failure must stop the run");
            assert!(text.contains(&format!("$hosts = '{HOSTS_PATH}'")));
            assert!(text.contains("'block' -eq 'block'"));
            assert!(text.contains("foreach ($d in @('a.com','b.com'))"));
            // -ceq, because -eq is case-insensitive and would treat a lowercase comment as our marker
            assert!(text.contains("-ceq '# BEGIN FOCUSBLOCKER'"));
            assert!(
                text.contains("[IO.File]::Replace($stage, $hosts, $null)"),
                "Move-Item deletes the destination first, which can leave no hosts file at all"
            );
        }

        #[test]
        fn clear_asks_for_no_domains() {
            let text = windows_render_script(&["clear".into()]);
            assert!(text.contains("'clear' -eq 'block'"));
            assert!(text.contains("foreach ($d in @())"));
        }

        #[test]
        fn the_encoded_command_is_utf16le_base64() {
            // cross-checked against node: Buffer.from(s, "utf16le").toString("base64")
            assert_eq!(base64_utf16le(""), "");
            assert_eq!(base64_utf16le("A"), "QQA=");
            assert_eq!(base64_utf16le("AB"), "QQBCAA==");
            assert_eq!(base64_utf16le("ABC"), "QQBCAEMA");
            assert_eq!(base64_utf16le("x.com"), "eAAuAGMAbwBtAA==");

            let blob = base64_utf16le(&windows_render_script(&["block".into(), "a.com".into()]));
            assert!(blob.is_ascii());
            assert_eq!(blob.len() % 4, 0, "base64 comes in groups of four");
            assert_eq!(
                blob.trim_end_matches('=').matches('=').count(),
                0,
                "padding belongs at the end and nowhere else"
            );
        }
    }
}

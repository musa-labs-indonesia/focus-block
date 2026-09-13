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

fn tmp_hosts_path() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::temp_dir().join("focusblock_hosts_tmp").to_string_lossy().to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        "/tmp/focusblock_hosts_tmp".to_string()
    }
}

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

fn db_path(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let new_path = dir.join("focusblock.db");
    // migrate from old identifier / old db name (focus-block)
    if !new_path.exists() {
        if let Ok(home) = std::env::var("HOME") {
            let old1 = PathBuf::from(format!("{}/.local/share/com.muhsalaa.focusblock/focusblock.db", home));
            let old2 = dir.join("focusblock.db");
            let old3 = PathBuf::from(format!("{}/.local/share/com.muhsalaa.focusblock/focusblock.db", home));
            for old in [old1, old2, old3] {
                if old.exists() {
                    let _ = std::fs::copy(&old, &new_path);
                    break;
                }
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

fn expand_sites(sites: Vec<String>) -> Vec<String> {
    let mut uniq = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in sites {
        if let Some(domain) = normalize_domain(&raw) {
            for alias in domain_aliases(&domain) {
                if uniq.insert(alias.clone()) {
                    out.push(alias);
                }
            }
        }
    }
    out
}

fn build_block_section(sites: &[String]) -> String {
    if sites.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    lines.push(MARKER_START.to_string());
    lines.push("# Managed by Focus Block - do not edit manually".to_string());
    for domain in sites {
        // block apex and www — only add www for apex domains (2 parts) to avoid www.m.youtube.com nonsense
        let is_apex = domain.split('.').count() == 2;
        lines.push(format!("127.0.0.1 {}", domain));
        lines.push(format!("::1 {}", domain));
        if is_apex {
            lines.push(format!("127.0.0.1 www.{}", domain));
            lines.push(format!("::1 www.{}", domain));
        }
    }
    lines.push(MARKER_END.to_string());
    lines.join("\n") + "\n"
}

fn strip_existing_block(content: &str) -> String {
    // remove existing block between markers inclusive (handle both old BLOCKER2 and new FOCUSBLOCKER)
    let mut result = String::new();
    let mut inside = false;
    for line in content.lines() {
        let trimmed = line.trim();
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

fn try_write_hosts_direct(content: &str) -> Result<(), String> {
    fs::write(HOSTS_PATH, content).map_err(|e| e.to_string())
}

// ponytail: macOS needs root for `killall mDNSResponder`, and the osascript prompt is the only root
// we get — so the flush rides along instead of failing unprivileged afterwards.
#[cfg(target_os = "macos")]
fn macos_admin_write_hosts(tmp_path: &str) -> String {
    format!(
        "do shell script \"cp '{}' '{}' && (killall -HUP mDNSResponder || true)\" with administrator privileges",
        tmp_path, HOSTS_PATH
    )
}

#[cfg(target_os = "linux")]
fn is_saved_auth_active() -> bool {
    fs::metadata(HELPER_PATH).is_ok() && fs::metadata(SUDOERS_PATH).is_ok()
}
#[cfg(not(target_os = "linux"))]
fn is_saved_auth_active() -> bool {
    false
}

fn write_hosts_privileged(content: &str) -> Result<(), String> {
    if try_write_hosts_direct(content).is_ok() {
        return Ok(());
    }
    let tmp_path = tmp_hosts_path();
    fs::write(&tmp_path, content).map_err(|e| format!("tmp write failed: {}", e))?;

    #[cfg(target_os = "linux")]
    {
        if is_saved_auth_active() {
            let helper_try = Command::new("sudo").args(["-n", HELPER_PATH, &tmp_path]).output();
            if let Ok(out) = helper_try {
                if out.status.success() {
                    let _ = fs::remove_file(&tmp_path);
                    flush_dns();
                    return Ok(());
                }
            }
            let sudo_cp = Command::new("sudo").args(["-n", "cp", &tmp_path, HOSTS_PATH]).output();
            if let Ok(out) = sudo_cp {
                if out.status.success() {
                    let _ = fs::remove_file(&tmp_path);
                    flush_dns();
                    return Ok(());
                }
            }
        } else {
            let sudo_try = Command::new("sudo").args(["-n", "cp", &tmp_path, HOSTS_PATH]).output();
            if let Ok(out) = sudo_try {
                if out.status.success() {
                    let _ = fs::remove_file(&tmp_path);
                    flush_dns();
                    return Ok(());
                }
            }
        }
        let pkexec_try = Command::new("pkexec").args(["cp", &tmp_path, HOSTS_PATH]).output();
        match pkexec_try {
            Ok(out) if out.status.success() => {
                let _ = fs::remove_file(&tmp_path);
                flush_dns();
                return Ok(());
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("pkexec failed: {} | host write requires admin (pkexec/sudo). Tip: enable saved authorization to skip this prompt.", stderr.trim()));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("pkexec not available: {} | sudo failed", e));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        // macOS: try sudo -n, then osascript with admin privileges
        let sudo_try = Command::new("sudo").args(["-n", "cp", &tmp_path, HOSTS_PATH]).output();
        if let Ok(out) = sudo_try {
            if out.status.success() {
                let _ = fs::remove_file(&tmp_path);
                flush_dns();
                return Ok(());
            }
        }
        let script = macos_admin_write_hosts(&tmp_path);
        let osascript = Command::new("osascript").args(["-e", &script]).output();
        match osascript {
            Ok(out) if out.status.success() => {
                let _ = fs::remove_file(&tmp_path);
                flush_dns();
                return Ok(());
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("macOS admin failed: {} | try running app with sudo or allow in prompt", stderr.trim()));
            }
            Err(e) => {
                let _ = fs::remove_file(&tmp_path);
                return Err(format!("osascript not available: {}", e));
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Windows: try direct already failed, need admin. Prompt via PowerShell Start-Process with RunAs
        // Fallback: instruct to run as Administrator
        let ps_script = format!("Start-Process -FilePath 'cmd' -ArgumentList '/c copy /Y \"{}\" \"{}\"' -Verb RunAs -Wait", tmp_path.replace('"', "\""), HOSTS_PATH.replace('"', "\""));
        let ps_try = Command::new("powershell").args(["-Command", &ps_script]).output();
        if let Ok(out) = ps_try {
            if out.status.success() {
                let _ = fs::remove_file(&tmp_path);
                flush_dns();
                return Ok(());
            }
        }
        let _ = fs::remove_file(&tmp_path);
        return Err("hosts write requires Administrator — right-click Focus Block → Run as Administrator, then Start session".to_string());
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
    let domains = expand_sites(sites);
    if domains.is_empty() {
        // if empty, just deactivate
        return deactivate_blocks();
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

    write_hosts_privileged(&new_content)?;
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
    write_hosts_privileged(&stripped)?;
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
            let t = line.trim();
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
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "enabled": is_saved_auth_active(),
    }))
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn enable_saved_auth() -> Result<String, String> {
    // helper script validates tmp and does cp + flush
    let helper_content = r#"#!/bin/sh
set -e
TMP="$1"
if [ -z "$TMP" ]; then echo "missing arg"; exit 1; fi
if [ ! -f "$TMP" ]; then echo "tmp not found: $TMP"; exit 1; fi
if [ -L "$TMP" ]; then echo "symlink not allowed"; exit 1; fi
SZ=$(wc -c < "$TMP" 2>/dev/null || echo 0)
if [ "$SZ" -gt 102400 ]; then echo "too large"; exit 1; fi
# basic safety: must contain our marker or be a valid hosts file (at least localhost)
# allow both block and unblock (with or without marker) — just ensure not empty
if [ "$SZ" -eq 0 ]; then echo "empty"; exit 1; fi
cp "$TMP" /etc/hosts
resolvectl flush-caches 2>/dev/null || systemd-resolve --flush-caches 2>/dev/null || true
"#;
    // write helper to tmp first then pkexec to move to proper place
    let tmp_helper = "/tmp/focusblock-helper-tmp";
    let tmp_sudoers = "/tmp/focusblock-sudoers-tmp";
    fs::write(tmp_helper, helper_content).map_err(|e| e.to_string())?;
    // get current user (tauri may not have USER env)
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
        .unwrap_or_else(|| "muhsalaa".to_string());
    // sudoers: allow helper with tmp arg, tight
    let sudoers_content = format!("{} ALL=(ALL) NOPASSWD: {} /tmp/focusblock_hosts_tmp\n", user, HELPER_PATH);
    fs::write(tmp_sudoers, &sudoers_content).map_err(|e| e.to_string())?;

    // one pkexec prompt installs helper + sudoers, and drops the legacy midnight reset so no stale
    // schedule can revoke an authorization that is meant to persist
    let script = format!(
        "cp {} {} && chmod 755 {} && cp {} {} && chmod 440 {} && rm -f {} {} {}",
        tmp_helper, HELPER_PATH, HELPER_PATH, tmp_sudoers, SUDOERS_PATH, SUDOERS_PATH, CRON_PATH, tmp_helper, tmp_sudoers
    );
    let out = Command::new("pkexec")
        .args(["sh", "-c", &script])
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

#[tauri::command]
fn get_global_blocks(handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let conn = get_conn(&handle)?;
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

#[tauri::command]
fn set_global_blocks(handle: tauri::AppHandle, sites: Vec<String>) -> Result<(), String> {
    let mut conn = get_conn(&handle)?;
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ensure db exists on startup (ponytail: WAL + 3 tables, no migration yet)
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
            get_active_session,
            save_active_session,
            clear_active_session
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // hard block: prevent close while session active (no escape)
                let app_handle = _window.app_handle();
                if let Ok(conn) = get_conn(&app_handle) {
                    if let Ok(mut stmt) = conn.prepare("SELECT end_at FROM active_session LIMIT 1") {
                        if let Ok(mut rows) = stmt.query([]) {
                            if let Ok(Some(row)) = rows.next() {
                                let end_at: i64 = row.get(0).unwrap_or(0);
                                let now = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as i64)
                                    .unwrap_or(0);
                                if end_at > now {
                                    api.prevent_close();
                                    return;
                                }
                            }
                        }
                    }
                }
                // best-effort hosts cleanup — try direct, then saved-auth helper (no prompt), then pkexec
                if let Ok(content) = fs::read_to_string(HOSTS_PATH) {
                    if is_block_active(&content) {
                        let stripped = strip_existing_block(&content);
                        let _ = try_write_hosts_direct(&stripped);
                        if fs::read_to_string(HOSTS_PATH)
                            .map(|c| is_block_active(&c))
                            .unwrap_or(false)
                        {
                            let tmp_path = tmp_hosts_path();
                            if fs::write(&tmp_path, &stripped).is_ok() {
                                let mut cleared = false;
                                if is_saved_auth_active() {
                                    if Command::new("sudo")
                                        .args(["-n", HELPER_PATH, &tmp_path])
                                        .output()
                                        .map(|o| o.status.success())
                                        .unwrap_or(false)
                                    {
                                        cleared = true;
                                    } else if Command::new("sudo")
                                        .args(["-n", "cp", &tmp_path, HOSTS_PATH])
                                        .output()
                                        .map(|o| o.status.success())
                                        .unwrap_or(false)
                                    {
                                        cleared = true;
                                        flush_dns();
                                    }
                                }
                                if !cleared {
                                    #[cfg(target_os = "linux")]
                                    {
                                        let _ = Command::new("pkexec").args(["cp", &tmp_path, HOSTS_PATH]).output();
                                    }
                                    #[cfg(target_os = "macos")]
                                    {
                                        let _ = Command::new("osascript")
                                            .args(["-e", &macos_admin_write_hosts(&tmp_path)])
                                            .output();
                                    }
                                    #[cfg(target_os = "windows")]
                                    {
                                        let ps = format!("Start-Process -FilePath 'cmd' -ArgumentList '/c copy /Y \"{}\" \"{}\"' -Verb RunAs -Wait", tmp_path.replace('"', "\""), HOSTS_PATH.replace('"', "\""));
                                        let _ = Command::new("powershell").args(["-Command", &ps]).output();
                                    }
                                } else {
                                    flush_dns();
                                }
                                let _ = fs::remove_file(&tmp_path);
                            }
                        }
                    }
                }
                // clear active_session so next launch doesn't resume with mismatched hosts
                let app_handle = _window.app_handle();
                if let Ok(conn) = get_conn(&app_handle) {
                    let _ = conn.execute("DELETE FROM active_session", []);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

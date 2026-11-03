//! The usage-meter mod's out-of-process work, one JSON object per run.
//!
//!   usage-meter-helper [--today] [--place <cwd>] [--account]
//!   usage-meter-helper --wait <state file> <cwd> <seconds>
//!   usage-meter-helper --cleanup|--forget <state file>
//!
//! --today    today's API-priced spend and prompt-cache hit rate across every
//!            Claude Code session on this machine, from the transcripts under
//!            ~/.claude/projects (subagents included)
//! --place    the folder name and git branch of <cwd>, read from .git directly
//! --account  the per-model weekly limits and the session limit from the
//!            account usage the app last cached in ~/.claude.json
//!
//! --wait     block until something changes, print it and exit (see `wait`)
//! --cleanup  delete other sessions' state files untouched for an hour
//! --forget   the same, and this session's own state file too
//!
//! Prints {"today": ..., "place": ..., "account": ...} with the asked-for keys.
//! A part that cannot be read is null; the run itself never fails.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ---- pricing ----

/// $ per million tokens: (input, output, cache read). Cache writes are 1.25x
/// input for the 5-minute TTL and 2x for the 1-hour TTL. Most specific first.
const PRICES: &[(&str, (f64, f64, f64))] = &[
    ("fable-5-1", (10.0, 50.0, 0.25)),
    ("mythos-5-1", (10.0, 50.0, 0.25)),
    ("fable-5", (10.0, 50.0, 1.0)),
    ("mythos-5", (10.0, 50.0, 1.0)),
    ("opus-5-5", (4.0, 20.0, 0.20)),
    ("opus-5", (5.0, 25.0, 0.50)),
    ("opus-4-8", (5.0, 25.0, 0.50)),
    ("opus-4-7", (5.0, 25.0, 0.50)),
    ("opus-4-6", (5.0, 25.0, 0.50)),
    ("opus-4-5", (5.0, 25.0, 0.50)),
    ("opus-4", (15.0, 75.0, 1.50)),
    ("sonnet-5-5", (2.0, 10.0, 0.20)),
    ("sonnet-5", (2.0, 10.0, 0.20)),
    ("sonnet-4", (3.0, 15.0, 0.30)),
    ("sonnet-3-7", (3.0, 15.0, 0.30)),
    ("haiku-5-5", (0.10, 0.50, 0.01)),
    ("haiku-4-5", (1.0, 5.0, 0.10)),
    ("haiku-3-5", (0.80, 4.0, 0.08)),
];
const HAIKU_55_LONG: (f64, f64, f64) = (0.50, 2.50, 0.05); // prompts over 100K tokens
const WEB_SEARCH_USD: f64 = 0.01; // per request

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    message: Option<Message>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    input_tokens: Option<f64>,
    output_tokens: Option<f64>,
    cache_read_input_tokens: Option<f64>,
    cache_creation_input_tokens: Option<f64>,
    cache_creation: Option<CacheCreation>,
    speed: Option<String>,
    server_tool_use: Option<ServerToolUse>,
}

#[derive(Deserialize)]
struct CacheCreation {
    ephemeral_1h_input_tokens: Option<f64>,
    ephemeral_5m_input_tokens: Option<f64>,
}

#[derive(Deserialize)]
struct ServerToolUse {
    web_search_requests: Option<f64>,
}

fn rates(model: &str) -> Option<(f64, f64, f64)> {
    PRICES.iter().find(|(key, _)| model.contains(key)).map(|(_, r)| *r)
}

fn price(model: &str, u: &Usage) -> Option<f64> {
    let mut r = rates(model)?;
    let n = |v: Option<f64>| v.unwrap_or(0.0);
    let inp = n(u.input_tokens);
    let out = n(u.output_tokens);
    let read = n(u.cache_read_input_tokens);
    let w1h = n(u.cache_creation.as_ref().and_then(|c| c.ephemeral_1h_input_tokens));
    let w5m = match u.cache_creation.as_ref().and_then(|c| c.ephemeral_5m_input_tokens) {
        Some(v) => v,
        None => (n(u.cache_creation_input_tokens) - w1h).max(0.0),
    };
    if model.contains("haiku-5-5") && inp + read + w5m + w1h > 100_000.0 {
        r = HAIKU_55_LONG;
    }
    let (i, o, c) = r;
    let mut usd = (inp * i + out * o + read * c + w5m * i * 1.25 + w1h * i * 2.0) / 1e6;
    if u.speed.as_deref() == Some("fast") {
        usd *= 2.0;
    }
    usd += n(u.server_tool_use.as_ref().and_then(|s| s.web_search_requests)) * WEB_SEARCH_USD;
    Some(usd)
}

// ---- today's spend ----

fn local_midnight() -> f64 {
    let today = Local::now().date_naive().and_hms_opt(0, 0, 0).expect("midnight exists");
    Local
        .from_local_datetime(&today)
        .earliest()
        .map(|d| d.timestamp_millis() as f64 / 1000.0)
        .unwrap_or(0.0)
}

fn projects_dir() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) => Some(PathBuf::from(d).join("projects")),
        None => std::env::var_os("HOME").map(|h| Path::new(&h).join(".claude").join("projects")),
    }
}

fn config_file() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) => Some(PathBuf::from(d).join(".claude.json")),
        None => std::env::var_os("HOME").map(|h| Path::new(&h).join(".claude.json")),
    }
}

fn is_transcript(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
}

fn jsonl_files(dir: &Path, since: f64, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            jsonl_files(&path, since, out);
        } else if kind.is_file() && is_transcript(&path) {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64());
            if modified.is_some_and(|m| m >= since) {
                out.push(path);
            }
        }
    }
}

/// Replies this far back are reported one by one, for the pace's activity
/// (how much was spent in the last minutes, across every session).
const RECENT_SECS: f64 = 3600.0;

/// The model's family as the account's limits name it: claude-fable-5-1 is
/// "Fable", claude-opus-5-5 "Opus".
fn family(model: &str) -> String {
    let rest = model.strip_prefix("claude-").unwrap_or(model);
    let name = rest.split('-').next().unwrap_or("");
    let mut chars = name.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn round(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    (v * f).round() / f
}

/// Today's totals, kept between reads: each transcript is read once up to its
/// last complete line, and later reads start where the last one stopped.
#[derive(Default, Serialize, Deserialize)]
struct Scanner {
    since: f64,
    offsets: HashMap<PathBuf, u64>,
    seen: HashSet<String>,
    sessions: HashSet<String>,
    unpriced: BTreeSet<String>,
    total: f64,
    replies: u64,
    cached: f64,
    prompt: f64,
    /// Today's spend by model family.
    #[serde(default)]
    by_model: BTreeMap<String, f64>,
    /// The last hour's replies: (seconds, usd, family), oldest first.
    #[serde(default)]
    recent: Vec<(f64, f64, String)>,
}

impl Scanner {
    fn new() -> Self {
        Scanner { since: local_midnight(), ..Default::default() }
    }

    /// Past midnight the totals start over; what was read stays read, since
    /// every line before the offsets is from yesterday.
    fn rollover(&mut self) -> bool {
        let midnight = local_midnight();
        if midnight == self.since {
            return false;
        }
        *self = Scanner {
            since: midnight,
            offsets: std::mem::take(&mut self.offsets),
            recent: std::mem::take(&mut self.recent), // activity straddles midnight
            ..Default::default()
        };
        true
    }

    fn full(&mut self, root: &Path) {
        let mut files = Vec::new();
        jsonl_files(root, self.since, &mut files);
        for path in files {
            self.read_new(&path);
        }
    }

    /// Reads what every transcript touched today gained since the last read:
    /// a stat per file, and only new bytes read. Returns whether any counted.
    fn catch_up(&mut self, root: &Path) -> bool {
        let mut files = Vec::new();
        jsonl_files(root, self.since, &mut files);
        let mut counted = false;
        for path in files {
            counted |= self.read_new(&path);
        }
        counted
    }

    /// Reads what was appended to `path` since the last read. Returns whether
    /// any line was counted.
    fn read_new(&mut self, path: &Path) -> bool {
        let Ok(mut file) = fs::File::open(path) else { return false };
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut start = self.offsets.get(path).copied().unwrap_or(0);
        if len < start {
            start = 0; // Rewritten in place: read it again; seen ids keep counts right.
        }
        if len == start || file.seek(SeekFrom::Start(start)).is_err() {
            return false;
        }
        let mut buf = Vec::with_capacity((len - start) as usize);
        if file.read_to_end(&mut buf).is_err() {
            return false;
        }
        // Only whole lines: a half-written last line waits for the next read.
        let Some(end) = buf.iter().rposition(|&b| b == b'\n') else { return false };
        self.offsets.insert(path.to_path_buf(), start + end as u64 + 1);
        let mut counted = false;
        for raw in buf[..end].split(|&b| b == b'\n') {
            counted |= self.line(path, raw);
        }
        counted
    }

    fn line(&mut self, path: &Path, raw: &[u8]) -> bool {
        // Cheap filter before parsing: only assistant replies carry usage.
        let line = String::from_utf8_lossy(raw);
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            return false;
        }
        let Ok(d) = serde_json::from_str::<Line>(&line) else { return false };
        if d.kind.as_deref() != Some("assistant") {
            return false;
        }
        let Some(msg) = d.message else { return false };
        let Some(u) = msg.usage else { return false };
        let Some(mid) = msg.id.or(d.request_id) else { return false };
        if self.seen.contains(&mid) {
            return false;
        }
        let Some(t) = d
            .timestamp
            .as_deref()
            .and_then(|ts| DateTime::parse_from_rfc3339(ts).ok())
            .map(|t| t.timestamp_millis() as f64 / 1000.0)
        else {
            return false;
        };
        if t < self.since {
            return false;
        }
        self.seen.insert(mid);
        let model = msg.model.unwrap_or_default();
        let Some(usd) = price(&model, &u) else {
            if !model.is_empty() && model != "<synthetic>" {
                self.unpriced.insert(model);
            }
            return false;
        };
        self.total += usd;
        self.replies += 1;
        let fam = family(&model);
        *self.by_model.entry(fam.clone()).or_insert(0.0) += usd;
        self.recent.push((t, usd, fam));
        self.prune_recent(t);
        let read = u.cache_read_input_tokens.unwrap_or(0.0);
        self.cached += read;
        self.prompt += read + u.input_tokens.unwrap_or(0.0) + u.cache_creation_input_tokens.unwrap_or(0.0);
        self.sessions.insert(d.session_id.unwrap_or_else(|| path.to_string_lossy().into_owned()));
        true
    }

    fn prune_recent(&mut self, now: f64) {
        let keep_from = now - RECENT_SECS;
        self.recent.retain(|(t, _, _)| *t >= keep_from);
        self.recent.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }

    fn report(&mut self) -> Value {
        self.prune_recent(now_secs());
        let by_model: BTreeMap<&String, f64> = self.by_model.iter().map(|(k, v)| (k, round(*v, 4))).collect();
        let recent: Vec<Value> = self
            .recent
            .iter()
            .map(|(t, usd, fam)| json!([(*t * 1000.0).round(), round(*usd, 5), fam]))
            .collect();
        json!({
            "usd": round(self.total, 4),
            "replies": self.replies,
            "sessions": self.sessions.len(),
            "cacheHit": if self.prompt > 0.0 { Some(round(self.cached * 100.0 / self.prompt, 1)) } else { None },
            "unpriced": self.unpriced,
            "byModel": by_model,
            "recent": recent,
            "date": Local::now().format("%Y-%m-%d").to_string(),
        })
    }
}

fn today() -> Value {
    let Some(root) = projects_dir() else { return Value::Null };
    let mut scanner = Scanner::new();
    scanner.full(&root);
    scanner.report()
}

// ---- folder and git branch ----

/// The git dir for `start`: the nearest `.git` above it, following a
/// worktree's or submodule's `gitdir:` file.
fn git_dir(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let dot = d.join(".git");
        if dot.is_dir() {
            return Some(dot);
        }
        if dot.is_file() {
            let text = fs::read_to_string(&dot).ok()?;
            let target = text.trim().strip_prefix("gitdir:")?.trim();
            return Some(d.join(target));
        }
        dir = d.parent();
    }
    None
}

fn branch(cwd: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir(cwd)?.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        return Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string());
    }
    // Detached: name the commit instead.
    (head.len() >= 7).then(|| format!("@{}", &head[..7]))
}

fn place(cwd: &str) -> Value {
    let path = Path::new(cwd);
    let folder = path
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string());
    json!({ "folder": folder, "branch": branch(path) })
}

// ---- cached account limits ----

fn account() -> Value {
    let Some(file) = config_file() else { return Value::Null };
    let Ok(text) = fs::read_to_string(file) else { return Value::Null };
    let Ok(config) = serde_json::from_str::<Value>(&text) else { return Value::Null };
    let cache = &config["cachedUsageUtilization"];
    let fetched_at = cache["fetchedAtMs"].as_f64().unwrap_or(0.0);
    let limits = cache["utilization"]["limits"].as_array().cloned().unwrap_or_default();

    let percent = |l: &Value| l["percent"].as_f64().unwrap_or(0.0);
    let resets = |l: &Value| l["resets_at"].as_str().map(str::to_string);

    let models: Vec<Value> = limits
        .iter()
        .filter(|l| l["kind"] == "weekly_scoped")
        .filter_map(|l| {
            let name = l["scope"]["model"]["display_name"].as_str()?;
            (!name.is_empty()).then(|| json!({ "name": name, "percent": percent(l), "resetsAt": resets(l) }))
        })
        .collect();
    let session = limits
        .iter()
        .find(|l| l["kind"] == "session")
        .map(|l| json!({ "percent": percent(l), "resetsAt": resets(l) }));

    json!({ "fetchedAt": fetched_at, "session": session, "models": models })
}

// ---- wait mode: block until something changes, print it, exit ----

/// What one `--wait` run hands the next through the state file.
#[derive(Default, Serialize, Deserialize)]
struct WaitState {
    scanner: Scanner,
    /// The parts as last printed, so a run prints only what changed.
    last: serde_json::Map<String, Value>,
}

/// One round of the mod's live loop: `--wait <state file> <cwd> <seconds>`.
///
/// The first run (no state file) scans everything and prints all three parts.
/// Later runs pick up where the state file left off: first whatever changed
/// since the last run, else they wait on file-system events for the
/// transcripts, ~/.claude.json and the git HEAD of `cwd` until something
/// changes or `seconds` pass. Prints one JSON object with the changed parts
/// ({} when nothing did) and saves the state for the next run.
fn wait(state_path: &str, cwd: &str, seconds: u64) {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let root = projects_dir();
    let config = config_file();
    let head = git_dir(Path::new(cwd)).map(|g| g.join("HEAD"));

    let loaded: Option<WaitState> = fs::read(state_path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let is_first = loaded.is_none();
    let mut state = loaded.unwrap_or_else(|| WaitState { scanner: Scanner::new(), last: Default::default() });

    // Every part as it stands; only those that differ from the last print go out.
    let changed = |state: &mut WaitState, spent: bool| -> serde_json::Map<String, Value> {
        let mut parts = vec![("place", place(cwd)), ("account", account())];
        if spent || !state.last.contains_key("today") {
            parts.push(("today", state.scanner.report()));
        }
        let mut out = serde_json::Map::new();
        for (k, v) in parts {
            if state.last.get(k) != Some(&v) {
                state.last.insert(k.to_string(), v.clone());
                out.insert(k.to_string(), v);
            }
        }
        out
    };

    // Set up the watch before catching up, so nothing slips between the two.
    let (tx, rx) = mpsc::channel();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev.paths);
        }
    });
    if let Ok(mut w) = watcher {
        if let Some(r) = &root {
            let _ = w.watch(r, RecursiveMode::Recursive);
        }
        // Files replaced by rename are seen through their folders.
        if let Some(dir) = config.as_deref().and_then(Path::parent) {
            let _ = w.watch(dir, RecursiveMode::NonRecursive);
        }
        if let Some(dir) = head.as_deref().and_then(Path::parent) {
            let _ = w.watch(dir, RecursiveMode::NonRecursive);
        }

        let rolled = state.scanner.rollover();
        let spent = match &root {
            Some(r) if is_first => {
                state.scanner.full(r);
                true
            }
            Some(r) => state.scanner.catch_up(r) | rolled,
            None => rolled,
        };
        let mut out = changed(&mut state, spent);

        let deadline = Instant::now() + Duration::from_secs(seconds);
        while out.is_empty() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            let Ok(mut paths) = rx.recv_timeout(left) else { break };
            // A reply writes several times in a burst: take the whole burst at once.
            let settle = Instant::now() + Duration::from_millis(150);
            while let Ok(more) = rx.recv_timeout(settle.saturating_duration_since(Instant::now())) {
                paths.extend(more);
            }
            let mut spent = state.scanner.rollover();
            paths.sort();
            paths.dedup();
            for p in &paths {
                if root.as_deref().is_some_and(|r| p.starts_with(r)) && is_transcript(p) {
                    spent |= state.scanner.read_new(p);
                }
            }
            out = changed(&mut state, spent);
        }
        drop(w);
        println!("{}", Value::Object(out));
    } else {
        // No file events on this machine: answer what changed since last time.
        let spent = root.as_deref().map(|r| state.scanner.catch_up(r)).unwrap_or(false);
        println!("{}", Value::Object(changed(&mut state, spent || is_first)));
    }

    if let Ok(bytes) = serde_json::to_vec(&state) {
        let tmp = format!("{state_path}.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, state_path);
        }
    }
}

// ---- cleanup of the wait loop's state files ----

/// Removes wait-loop state files in the same folder as `state` that no run has
/// touched for `stale_secs` (their sessions ended), and `state` itself when
/// `forget` is set (its session is ending). Prints {"removed": n}.
fn cleanup(state: &str, stale_secs: u64, forget: bool) {
    let path = Path::new(state);
    let dir = path.parent().unwrap_or(Path::new("/tmp"));
    let mut removed = 0u32;
    if forget {
        for p in [path.to_path_buf(), PathBuf::from(format!("{state}.tmp"))] {
            if fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let ours = name.starts_with("usage-meter-") && (name.ends_with(".json") || name.ends_with(".json.tmp"));
            if !ours || p == path {
                continue;
            }
            let age = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs());
            if age.is_some_and(|a| a >= stale_secs) && fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    println!("{}", json!({ "removed": removed }));
}

fn main() {
    let mut out = serde_json::Map::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cleanup" | "--forget" => {
                let state = args.next().unwrap_or_default();
                cleanup(&state, 3600, arg == "--forget");
                return;
            }
            "--wait" => {
                let state = args.next().unwrap_or_default();
                let cwd = args.next().unwrap_or_default();
                let seconds = args.next().and_then(|s| s.parse().ok()).unwrap_or(20);
                wait(&state, &cwd, seconds);
                return;
            }
            "--today" => {
                out.insert("today".into(), today());
            }
            "--place" => {
                let cwd = args.next().unwrap_or_default();
                out.insert("place".into(), place(&cwd));
            }
            "--account" => {
                out.insert("account".into(), account());
            }
            _ => {}
        }
    }
    println!("{}", Value::Object(out));
}

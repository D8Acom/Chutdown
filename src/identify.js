// Which session is a tab actually RUNNING? - the exact answer, from claude's own files.
//
// Every live claude CLI keeps `~/.claude/sessions/<pid>.json`: its pid, its sessionId,
// its cwd. A terminal tab knows only its SHELL pid, and claude sits somewhere below it,
// so the two are joined by walking the process table up: the claude pid whose ancestors
// include the tab's shell pid is that tab's session. No guessing from cwd, from tab
// order, or from when the terminal happened to open.
//
// That listing is the one OS call in here, and it belongs to the platform module rather
// than to this one: Get-CimInstance Win32_Process on Windows, `ps -A -o pid=,ppid=,
// lstart=` on macOS and anywhere else POSIX. Nothing below asks which OS this is.
// platform.processTableArgv() returning null is what "there is no way to list processes
// here" means, and it is the only gate - a capability question, not an OS question, so a
// platform that grows a listing gets tab identification without a line changing here.
// The one field whose FORMAT differs between them - when a process started, FILETIME
// ticks on Windows and a ctime string from ps on POSIX - is opaque to this file too;
// platform.startMatches() is the only thing allowed to read it.
//
// This is what gives a tab still wearing its creation name ("claude") its OLD name
// back. Once the session id is known it is the key into the name cache written by
// every previous window, so the tab is renamed to whatever that session was called
// before - the case the event-driven paths cannot cover at all: a claude already
// running when this extension woke up was never announced by onDidOpenTerminal or by
// a shell execution, so nothing else in here ever learns it exists.

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const shared = require('./shared');
const platform = require('./platform');

// A sweep forks a process listing, so it never rides the 5s poll: it runs only while
// something is still unidentified, and then at MIN_GAP at most. An unchanged set of
// unidentified tabs - the usual state, since an ordinary shell tab is a candidate
// that will never match - drops to SLOW_GAP instead of listing processes for ever.
// Both gaps stay the same on every platform even though one `ps` costs a small
// fraction of what a PowerShell listing does: what they pace is not the listing, it is
// a question whose answer cannot change until the tab set does, asked on the single
// thread every other extension in this window is sharing.
const MIN_GAP_MS = 15_000;
const SLOW_GAP_MS = 5 * 60_000;
let busy = false;
let lastRun = 0;
let lastKey = '';
let lastMiss = '';

/// The claude processes that are alive RIGHT NOW and belong to this workspace.
/// `kind` filters out headless runs (`claude -p`) - the AI namer is one of those, and
/// it must never be mistaken for the session sitting in a tab.
function liveClaudeSessions(table) {
    const scan = require('./scan');
    let files = [];
    try { files = fs.readdirSync(shared.SESSIONS); } catch { return []; }
    const out = [];
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        let rec;
        try { rec = JSON.parse(fs.readFileSync(path.join(shared.SESSIONS, f), 'utf8')); } catch { continue; }
        if (!rec || !rec.pid || !rec.sessionId) continue;
        if (rec.kind && rec.kind !== 'interactive') continue;
        if (!scan.underWorkspace(rec.cwd)) continue;
        const live = table.get(Number(rec.pid));
        if (!live) continue;                       // process gone - a leftover file
        // ...and the pid was not handed to something else since. Two processes can wear
        // the same number weeks apart, so a session file is trusted only while the
        // process sitting on its pid now STARTED when the file says it did. Which clock
        // that is written on differs per OS, so the comparison is the platform's: a
        // platform with nothing to check with answers true, and identification falls
        // back to the session file alone rather than matching nothing at all.
        if (!platform.startMatches(rec, live.start)) continue;
        out.push(rec);
    }
    return out;
}

/// Is `pid` a descendant of `ancestor`? Never a direct child in practice on Windows: a
/// claude in a bash tab here sits THREE levels under the shell VS Code reports
/// (claude.exe <- bash <- bash <- the shell pid), and a cmd.exe tab has its own shim
/// hops. The hop limit is what stops a corrupted table looping for ever.
///
/// That depth is an npm .cmd-shim artefact rather than anything about claude, so macOS
/// is SHALLOWER, not deeper: our terminal profile runs
/// `$SHELL -l -i -c 'claude; exec $SHELL -l'`, which forks claude as a direct child of
/// the shell VS Code reports, and every install route there - the native binary's
/// symlink, an npm shebang, Homebrew - is one process rather than a wrapper calling a
/// wrapper. 12 hops is ample on both, so there is no per-platform limit here.
///
/// Two macOS cases genuinely have no ancestry to walk, and both are left to fail closed
/// with a single miss() line rather than papered over. Under tmux or screen the tab's
/// processId is the multiplexer CLIENT while claude lives under the multiplexer SERVER,
/// which is not a descendant of anything this tab knows about; and a claude whose parent
/// shell died is reparented to launchd (pid 1), which ends the walk one hop later. The
/// tempting repair for both - matching on cwd instead - is what this whole module exists
/// to avoid: two claudes in the same folder is the ordinary case, and a cwd match would
/// hand a tab someone else's session id, name and all.
function descendsFrom(pid, ancestor, table) {
    let cur = Number(pid);
    for (let hop = 0; hop < 12 && cur; hop++) {
        if (cur === ancestor) return true;
        const row = table.get(cur);
        if (!row) return false;
        cur = row.ppid;
    }
    return false;
}

/// Every tab that still needs identifying: one we track but never paired with a
/// session, and any terminal we know nothing about at all (a claude that was already
/// running before this window loaded). Batch `.terminals` tabs are excluded - they
/// have their own entries and their own names.
function candidates() {
    const live = vscode.window.terminals;
    const out = [];
    for (const rec of shared.claudeRecs)
        if (!rec.sessionId && live.includes(rec.terminal)) out.push({ terminal: rec.terminal, rec });
    for (const t of live) {
        if (shared.claudeRecs.some((r) => r.terminal === t)) continue;
        let batch = false;
        for (const r of shared.termRecs.values()) if (r.terminal === t) batch = true;
        if (!batch) out.push({ terminal: t, rec: null });
    }
    return out;
}

/// A stable identity for a terminal, for the backoff key below and nothing else.
///
/// The key used to be built from terminal.name, which is the one property of an
/// unidentified claude tab that CANNOT hold still: a claude that was already running
/// when this window loaded never got CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1, so it writes
/// its own status into its title - and that is precisely the tab this module exists to
/// resolve. The key therefore differed on almost every poll, `key === lastKey` was never
/// true, and the 5-minute slow path was dead code: an unidentifiable tab left open ran a
/// Get-CimInstance Win32_Process listing every 15 seconds for as long as it sat there.
///
/// A WeakMap counter is immune to that and needs no await (terminal.processId is a
/// promise, and this is called from the synchronous poll). Entries go when the terminal
/// is collected.
const tabIds = new WeakMap();
let nextTabId = 1;
function tabId(t) {
    let id = tabIds.get(t);
    if (id === undefined) { id = nextTabId++; tabIds.set(t, id); }
    return id;
}

/// Called from the poll: cheap and silent while there is nothing to identify.
function kick() {
    if (!platform.processTableArgv() || busy) return;   // no listing here = nothing to ask
    if (!shared.cfg().get('identifyTabs')) return;
    const list = candidates();
    if (!list.length) return;
    const key = list.map((c) => (c.rec ? 'r:' : 't:') + tabId(c.terminal)).sort().join('|');
    if (Date.now() - lastRun < (key === lastKey ? SLOW_GAP_MS : MIN_GAP_MS)) return;
    lastKey = key;
    lastRun = Date.now();
    busy = true;
    sweep().catch((e) => shared.nlog('identify: ' + e.message)).then(() => { busy = false; });
}

/// The one-off startup pass, run once the restored tabs have settled: whatever the
/// restore left unbound is matched against the claude processes that are actually
/// running, right now, instead of waiting for the gap above to come round. Resolves
/// when there is nothing more to learn - the status bar's spinner waits on it.
async function sweepNow() {
    if (!platform.processTableArgv()) return;          // no listing here = nothing to ask
    if (!shared.cfg().get('identifyTabs')) return;
    if (busy || !candidates().length) return;
    busy = true;
    lastRun = Date.now();
    try { await sweep(); } catch (e) { shared.nlog('identify: ' + e.message); }
    busy = false;
}

async function sweep() {
    const claude = require('./claude');
    const list = candidates();
    if (!list.length) return;
    // Shell pids resolve asynchronously; a terminal that never gives one up (it died
    // mid-sweep) simply drops out.
    const withPid = [];
    for (const c of list) {
        let pid = 0;
        try { pid = await c.terminal.processId; } catch { }
        if (pid) withPid.push(Object.assign({ pid }, c));
    }
    if (!withPid.length) return;

    const table = await platform.processTable();
    if (!table.size) return;
    const sessions = liveClaudeSessions(table);
    if (!sessions.length) {
        miss('no live claude process belongs to this workspace');
        return;
    }
    // A session already wearing a tab is spoken for - only the leftovers are on offer.
    const taken = new Set(shared.claudeRecs.map((r) => r.sessionId).filter(Boolean));
    let found = 0;
    for (const c of withPid) {
        const hit = sessions.find((p) => !taken.has(p.sessionId) && descendsFrom(p.pid, c.pid, table));
        if (!hit) continue;
        taken.add(hit.sessionId);
        found++;
        claude.claimTab(c.terminal, c.rec, hit);
    }
    if (found) claude.renameActiveClaude();
    else miss(withPid.length + ' unidentified tab(s), none running a claude of this workspace');
}

function miss(why) {
    if (why === lastMiss) return;
    lastMiss = why;
    shared.nlog('identify: ' + why);
}

Object.assign(module.exports, { kick, sweepNow });

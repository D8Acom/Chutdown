// Session scanning - reads the transcripts Claude Code writes under
// ~/.claude/projects (same detection as the desktop app): discovers sessions,
// classifies their state from the transcript tail, and extracts the first prompt
// plus the scanned-word placeholder name.

const fs = require('fs');
const path = require('path');

const shared = require('./shared');
const naming = require('./naming');

function workspaceRoots() {
    const vscode = require('vscode');
    return (vscode.workspace.workspaceFolders || [])
        .map((f) => f.uri.fsPath.replace(/[\\/]+$/, '').toLowerCase());
}

function underWorkspace(cwd) {
    if (!cwd) return false;
    const c = cwd.replace(/[\\/]+$/, '').toLowerCase();
    return workspaceRoots().some((r) => c === r || c.startsWith(r + '\\') || c.startsWith(r + '/'));
}

/// ---------------------------------------------------------------- folders that can matter
///
/// Claude Code files a transcript under a directory named after the cwd it was started
/// in, with every character that is not a letter or a digit flattened to a dash
/// (C:\Users\me\proj -> C--Users-me-proj). So the only directories that can hold THIS
/// workspace's sessions are its roots' flattened names, and the names of folders under
/// them - everything else is another project and can be skipped without a single stat.
///
/// This is not a micro-optimisation. Every scan used to stat every transcript in every
/// project on the machine: 600 files across 22 projects here, on the extension host
/// thread, five times a minute AND on every fs.watch wake - about once a second while
/// any claude anywhere is writing. VS Code marks an extension that hogs that thread
/// "unresponsive", and it was right to.
///
/// If no directory matches - a workspace that has never run claude, or a naming rule
/// that has changed under us - the scan falls back to walking all of them, which is
/// what it always did. Correct either way; only the cost differs.
function projectDirName(root) { return root.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(); }

/// The flattened root names, rebuilt only when the workspace folders change - this is
/// called from the fs.watch callback, which on a busy machine fires thousands of times
/// a minute.
let rootKey = '';
let rootDirs = [];
function ourRootDirs() {
    const roots = workspaceRoots();
    const key = roots.join('|');
    if (key !== rootKey) { rootKey = key; rootDirs = roots.map(projectDirName); }
    return rootDirs;
}

function mayHoldOurs(name) {
    const n = String(name || '').toLowerCase();
    return ourRootDirs().some((f) => n === f || n.startsWith(f + '-'));
}

/// How many of the directories in ~/.claude/projects are ours - and 0 means "cannot
/// tell", so scan them all.
let dirFallback = false;   // did the "nothing matched, walk them all" branch fire?
function ourDirs(dirs) {
    const mine = dirs.filter((d) => d.isDirectory() && mayHoldOurs(d.name));
    dirFallback = !mine.length;
    if (mine.length) return mine;
    return dirs.filter((d) => d.isDirectory());
}

let firstScanDone = false;
let lastDirCount = -1;   // only logged when it moves

/// How long Claude Code goes on touching a transcript after its turn ended - the
/// `away_summary` recap lands about three minutes later - with margin. Past this, a
/// write is the session actually doing something again.
const RECAP_GRACE_MS = 10 * 60_000;

/// transcript path -> the mtime at which it was found to belong to another project.
/// Bounded by the lookback window, and entries for files that stop being scanned are
/// swept below, so this cannot grow without limit.
const foreignFiles = new Map();

// ------------------------------------------------- what the CLI says about itself
//
// The transcript cannot see a question. A pending AskUserQuestion / ExitPlanMode is NOT
// written to the .jsonl until it is ANSWERED - the assistant record carrying the tool_use
// and the user record carrying the result land together, afterwards - so while the
// question is on screen the newest record is still the prompt that led to it. From the
// transcript alone that is indistinguishable from a turn still running, which is why a
// session sitting on a question read as 🟢 processing and held the shutdown open instead
// of going 🟠.
//
// Claude Code does record it, though, in its own per-process file:
//
//   ~/.claude/sessions/<pid>.json   { sessionId, cwd, status, statusUpdatedAt, ... }
//
//   status: "busy"     a turn is in flight
//           "waiting"  BLOCKED ON THE USER - a question, a plan approval, a permission
//                      prompt. The one state the transcript never shows.
//           "idle"     nothing running
//           "shell"    ...and there are others. This one turned up while watching a real
//                      session, after the four we knew about, which is the point: only
//                      "waiting" and "idle" are acted on and every other value - present
//                      or future - leaves the transcript's own verdict exactly as it was.
//                      A status this file has never heard of must never change a light.
//
// It is used only to REFINE what the transcript already said, never to overrule it: the
// transcript stays the source of truth for what happened, and this answers the one
// question it cannot - whether the CLI is still computing. Sessions with no file (an
// older CLI, a session from another machine) behave exactly as they did before.
const CLI_STATUS_MAX_AGE = 12 * 3_600_000;   // a file older than this is from a dead run

function cliStatuses() {
    const out = new Map();
    let files = [];
    try { files = fs.readdirSync(shared.SESSIONS); } catch { return out; }
    const now = Date.now();
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        let rec;
        try { rec = JSON.parse(fs.readFileSync(path.join(shared.SESSIONS, f), 'utf8')); } catch { continue; }
        if (!rec || !rec.sessionId || !rec.status) continue;
        const at = Number(rec.statusUpdatedAt || rec.updatedAt || 0);
        // An UNDATED file is dropped, not trusted. `at && …` let one through forever:
        // its `status` would refine a live session's state for the rest of the day, and
        // a stale "idle" landing on a working session reads as `awaiting`, which the
        // gears count as finished after the settle. Every file this CLI writes carries
        // `statusUpdatedAt` - the `|| 0` above exists because that is not guaranteed,
        // and what cannot be dated cannot be aged out.
        if (!at || now - at > CLI_STATUS_MAX_AGE) continue;
        // Several files can name the same session across restarts - the freshest wins.
        const had = out.get(rec.sessionId);
        if (had && had.at >= at) continue;
        out.set(rec.sessionId, { status: String(rec.status), at,
            // The CLI's session name rides in the same file. It stamps `nameSource`
            // ONLY on names it made up itself - "derived" at startup ("chutdown-4f"),
            // "collision" after a clash - so a name WITHOUT one is the user's own,
            // typed as /rename or `claude --name` (verified against the 2.1.235 CLI:
            // its pid-file writer drops every other source value on the floor).
            name: typeof rec.name === 'string' ? rec.name : '',
            ownName: rec.nameSource === 'derived' || rec.nameSource === 'collision' });
    }
    return out;
}

/// Fold the CLI's own status into a session whose transcript reads as 'working'. That is
/// the only state it can improve on: 'working' means "a prompt went in and nothing has
/// come back", which covers a turn in flight, a question on screen, and a prompt that was
/// cancelled - three very different things the transcript writes identically.
function applyCliStatus(s, cli) {
    // Back to what the transcript said, then refine again from scratch - see the `s.tail`
    // snapshot above for why this is not merely tidiness.
    if (s.tail) {
        s.state = s.tail.state;
        s.question = s.tail.question;
        s.awaitingReply = s.tail.awaitingReply;
    }
    s.waiting = false;
    if (!cli) return;                       // no file: every rule below stays as it was
    if (s.state !== 'working') return;
    if (cli.status === 'waiting') {
        // A question, a plan approval, or a permission prompt: the turn has stopped and
        // it is stopped ON YOU. 🟠, and the armed shutdown holds (shutdown.js).
        s.state = 'awaiting';
        s.question = true;
        s.waiting = true;
        s.awaitingReply = false;
        // Measured from when the CLI said so, not from the last write: the transcript
        // has not moved since before the question went up.
        s.waitingSince = cli.at || Date.now();
        return;
    }
    if (cli.status === 'idle') {
        // The prompt is not being worked on and nothing is blocked on the user, so the
        // turn is over - answered and not yet flushed, or cancelled before it ever
        // started. This is what noReplyMinutes was guessing at with a five-minute timer;
        // where the file exists, there is nothing left to guess.
        s.state = 'awaiting';
        s.awaitingReply = false;
    }
}

/// VS Code does NOT coerce a setting that violates the contributed schema - a string or
/// a null arrives exactly as written. Unguarded, `Date.now() - 'soon' * 3_600_000` is
/// NaN, and `st.mtimeMs < NaN` is false for every file on disk, so the lookback silently
/// became infinite: every transcript in every project statted and tail-parsed on every
/// 5 s poll, on the extension host thread. The two readers in lights.js already clamp
/// this way; scanSessions is the one that pays for getting it wrong.
function lookbackMs() {
    const n = Number(shared.cfg().get('lookbackHours'));
    return Math.max(1, isFinite(n) && n > 0 ? n : 24) * 3_600_000;
}

function scanSessions() {
    const cutoff = Date.now() - lookbackMs();
    const cli = cliStatuses();
    const seen = new Set();
    const scannedFiles = new Set();
    let dirs = [];
    try { dirs = fs.readdirSync(shared.PROJECTS, { withFileTypes: true }); } catch { return; }
    const mine = ourDirs(dirs);
    if (mine.length !== lastDirCount) {
        lastDirCount = mine.length;
        shared.nlog('scan: ' + mine.length + ' of ' + dirs.length +
            ' project folder(s) can hold this workspace' +
            // The counts being equal is NOT the fallback: on a machine with one project
            // every directory is ours, and the log then claimed the opposite of the truth.
            (dirFallback ? ' (none matched by name - walking them all)' : ''));
    }

    for (const d of mine) {
        const dir = path.join(shared.PROJECTS, d.name);
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const file = path.join(dir, f);
            let st;
            try { st = fs.statSync(file); } catch { continue; }
            if (st.mtimeMs < cutoff) continue;

            const id = f.slice(0, -6);
            // A transcript belonging to some OTHER project is skipped below, after its
            // tail is parsed - and because the record is then thrown away rather than
            // kept, the next scan started over: a fresh record with parsedMtime 0, so
            // the 256 KB tail read and JSON parse ran AGAIN, for every foreign
            // transcript touched in the lookback window, every poll and every fs.watch
            // wake. With a dozen active projects that is megabytes of synchronous file
            // I/O per tick on the extension host thread, for a result thrown away every
            // time. The verdict is remembered against the file's own mtime instead, and
            // re-checked only when the file actually changes.
            scannedFiles.add(file);
            const foreign = foreignFiles.get(file);
            if (foreign === st.mtimeMs) continue;
            const sup = shared.suppressed.get(id);
            let s = shared.sessions.get(id);
            // On the very first scan firstSeen is the transcript's own age, not "now" -
            // otherwise every pre-existing session looks newborn and can steal the
            // binding of a terminal opened right after startup.
            if (!s) s = { id, file, dir, cwd: '', state: 'unknown', lastText: '', lastPrompt: '',
                          name: '', model: '', parsedMtime: 0, lastWriteMs: 0,
                          firstSeen: firstScanDone ? Date.now() : st.mtimeMs };

            if (st.mtimeMs !== s.parsedMtime) {
                const read = parseTail(s);
                // Only a tail that was actually READ is a verdict worth remembering. A
                // failed read leaves parsedMtime alone so the next tick retries, instead
                // of latching "could not see" against this mtime until the transcript
                // happens to move again - which, mid tool call, can be many minutes.
                if (read) s.parsedMtime = st.mtimeMs;
                // The tail's own verdict, kept aside: applyCliStatus refines it on every
                // scan and has to start from what the FILE said each time, or its own
                // last refinement would be the thing it refines. Without this, a question
                // answered at 10:00 leaves the session reading 'awaiting' until the
                // transcript happens to move again. Refreshed on a failed read too, or
                // the 'unparsed' just set would be overwritten from the stale snapshot.
                s.tail = { state: s.state, question: s.question, awaitingReply: s.awaitingReply };
            }
            // ...and then what the CLI says about itself, EVERY scan - not only when the
            // transcript changed. A question going up moves no bytes in the .jsonl, so a
            // refinement gated on the mtime would never run for the one case it is for.
            // Re-parsing is not needed either: parseTail's verdict is cached in `s`, and
            // this only ever adjusts 'working' into what 'working' actually means.
            applyCliStatus(s, cli.get(id));
            s.lastWriteMs = st.mtimeMs;
            if (!s.cwd || !underWorkspace(s.cwd)) { foreignFiles.set(file, st.mtimeMs); continue; }
            foreignFiles.delete(file);

            // A session whose claude tab was closed is DEMOTED to the "idle" dropdown
            // (no individual light, ignored by the armed shutdown) - it stays listed,
            // however young, until genuinely new transcript activity (a resume)
            // promotes it back to a live light.
            //
            // "Genuinely new" cannot be the file's mtime. Claude Code keeps touching a
            // FINISHED transcript for minutes - `turn_duration` immediately, then the
            // `away_summary` recap about three minutes later - and a receipt that any
            // later write spends was spent by that recap: the light the user had just
            // closed reappeared on its own, three minutes after they closed it, and the
            // persisted dismissal went with it so a reload did not bring it back either.
            // So the receipt is spent by a TURN MOVING again, read from the parsed tail:
            // the session is working, or it started awaiting something newer than the
            // dismissal. Bookkeeping records change neither. Evaluated here, after the
            // workspace gate, so a dismissal for a session in another folder is not
            // quietly dropped from workspaceState by this window in passing.
            if (sup !== undefined) {
                const since = st.mtimeMs - sup;
                const resumed = since > 5000 &&
                    (s.state === 'working' || (s.awaitingSince || 0) > sup ||
                     // Backstop for a whole turn that started AND finished between two
                     // scans, where neither test above sees it: the bookkeeping is all
                     // over within ~3 minutes of a turn ending, so a write this much
                     // later is not bookkeeping whatever the tail says.
                     since > RECAP_GRACE_MS);
                if (resumed) { shared.suppressed.delete(id); shared.saveSuppressed(); }
                s.closedTab = !resumed;
            } else s.closedTab = false;
            // Re-derived while there is still something to derive - but only while the
            // transcript has GROWN since the last attempt. firstPrompt() reads the
            // first 64 KB and legitimately comes back empty (an opening message that is
            // an image or an attachment, or a first prompt past that 64 KB), and the
            // condition below is then permanently true: 64 KB re-read from disk plus a
            // full globalState deserialise, on every scan, for the life of the window,
            // for a result that never changes.
            if ((!s.name || !s.prompt) && s.promptTriedAt !== st.mtimeMs) {
                s.promptTriedAt = st.mtimeMs;
                // One word only in the status bar - space is scarce there; the full
                // prompt stays in the hover. The whole question is SCANNED for a
                // distinctive word (not just whatever happens to be first - that gave
                // tabs named "the"); the AI namer then VERIFIES it after the first turn.
                s.prompt = firstPrompt(file);
                const cached = naming.cachedName(id);
                if (cached) {
                    s.name = shared.uniqueName(id, cached);
                    s.aiNamed = true;
                    // A cached word can collide with a session named after it was cached;
                    // keep the corrected word so the tab does not re-collide next window.
                    if (s.name !== cached) naming.cacheName(id, s.name);
                } else if (s.prompt) {
                    // Every distinctive word of the question, best first: if the best one
                    // is already worn by another tab, the next one from THIS prompt beats
                    // a counter that says nothing (see goodWord).
                    s.name = goodWord(s.prompt, id);
                }
                else if (!s.name) s.name = id.slice(0, 8);
            }
            // A /rename typed into the CLI itself - adopted after the placeholder
            // naming above, so a human's word wins over the scanned one.
            adoptCliName(s, cli.get(id));

            // WHEN the turn ended, which is not the same as the last byte written.
            // Claude Code keeps touching a finished transcript: `turn_duration` right
            // away, `last-prompt`/`mode`, and the `away_summary` recap ~3 MINUTES
            // later. None of that is Claude working again, so the "everything is
            // finished" test must not measure from it - that recap was what made the
            // chime sound a second time, three minutes after the first.
            if (s.state === 'awaiting') { if (!s.awaitingSince) s.awaitingSince = st.mtimeMs; }
            else s.awaitingSince = 0;

            // Background agents/workflows run on while the main thread is 'awaiting'.
            // Their sidecar writes still push lastWriteMs (the hover's quiet time), but
            // whether they are STILL WORKING is read from their own transcripts' tails
            // (backgroundBusy) - the same stop_reason rule as the main thread, never
            // the mtime. Judging them by mtime was the quiet-time mistake all over
            // again: six workflow agents in long tool calls once wrote nothing for 47
            // seconds and the chime fired with every one of them mid-turn.
            //
            // Both walks are recursive, and they used to run for EVERY session in the
            // lookback window on every scan: 32 finished sessions here meant ~380
            // readdir/stat calls five times a minute, on the extension host thread, to
            // re-answer "are these agents from this morning still going?" - the largest
            // single cost in the extension, and most of what got it marked
            // "unresponsive". A session that has written NOTHING (main transcript or
            // sidecar) for longer than an agent can be silent has no live agent by
            // definition: AGENT_DEAD_MS is exactly that bound, and the notification
            // grace is far shorter. So the walks stop once a session is that quiet, and
            // start again the moment it writes - a resume moves the main transcript
            // first, which is statted every scan regardless.
            const sideKnown = Math.max(st.mtimeMs, s.lastSideMs || 0);
            if (s.state === 'awaiting' && Date.now() - sideKnown < SIDECAR_WINDOW_MS) {
                const side = Math.max(
                    newestUnder(path.join(dir, id)),
                    newestUnder(path.join(shared.TASKS, id)));
                if (side) s.lastSideMs = Math.max(s.lastSideMs || 0, side);
                if (side > s.lastWriteMs) s.lastWriteMs = side;
                s.background = backgroundBusy(s, path.join(dir, id), st.mtimeMs);
            } else {
                // Nothing is walked, but what the last walk found is not forgotten: the
                // hover's quiet time still counts from the newest write we ever saw.
                if ((s.lastSideMs || 0) > s.lastWriteMs) s.lastWriteMs = s.lastSideMs;
                s.background = false;
            }

            // VERIFY the scanned word AFTER the first turn completes - the assistant's
            // answer says what the task really is, so the namer keeps the word if it
            // fits and replaces it only when a better one exists.
            // Working again = worth another look: this is the one event that re-arms a
            // session the namer skipped for being quiet, and it is why the skip path
            // does NOT clear the latch itself (naming.js).
            if (s.state === 'working') s.namerQueued = false;
            // ...and a session the user has closed is not named at all - the call is a
            // real `claude -p` run, spent on a tab that is already in the idle dropdown.
            if (!s.aiNamed && !s.namerQueued && s.prompt && s.state === 'awaiting' && !s.closedTab)
                s.namerQueued = naming.queueName(s);   // latch on the answer, not the attempt

            shared.sessions.set(id, s);
            seen.add(id);
        }
    }

    for (const id of [...shared.sessions.keys()])
        if (!seen.has(id)) shared.sessions.delete(id);
    // Files that aged out of the lookback window drop their cached verdict with them.
    for (const f of [...foreignFiles.keys()])
        if (!scannedFiles.has(f)) foreignFiles.delete(f);
    dedupeNames();
    firstScanDone = true;
}

/// A name the user gave the session INSIDE the CLI - `/rename`, or `claude --name` -
/// read from the same pid file as the status (see cliStatuses). It outranks everything
/// here, exactly like a hand-rename of the tab (claude.js): deduplicated through
/// uniqueName, cached so it survives a reload, aiNamed so the namer never
/// second-guesses it. Latched PER VALUE, so one /rename is adopted once - a later
/// rename from any other path (the tab, the hover's Edit name) is not fought over,
/// while the next /rename, being a new value, wins again.
function adoptCliName(s, cli) {
    if (!cli || !cli.name || cli.ownName) return;
    if (s.cliNameSeen === cli.name) return;
    s.cliNameSeen = cli.name;
    const word = cli.name.replace(/\s+/g, ' ').trim().slice(0, 14).trim();
    if (!word || word === s.name) return;
    const unique = shared.uniqueName(s.id, word);
    if (unique === s.name) return;
    shared.nlog('rename: "' + s.name + '" -> "' + unique + '" (/rename in the CLI: "' +
        cli.name + '")');
    s.name = unique;
    s.aiNamed = true;               // a human's word outranks the namer's
    naming.cacheName(s.id, unique);
}

/// Backstop for the uniqueness rule: assignment-time checks can only see the sessions
/// that already exist, so a name cached in an earlier window - or one restored beside
/// a twin - can still land on two tabs. This sweep runs after every scan and settles
/// it the same way every time: OLDEST session keeps the bare word, the newcomer moves
/// to another word from its own prompt (or a counter, if it has neither a prompt nor a
/// free word left), so nothing flip-flops between scans.
function dedupeNames() {
    const all = [...shared.sessions.values()].filter((s) => s.name)
        .sort((a, b) => (a.firstSeen - b.firstSeen) || (a.id < b.id ? -1 : 1));
    // Two sets, because the replacement has to dodge names this sweep has not REACHED
    // yet. `kept` is what has been through the loop (first one in wins the bare word);
    // `taken` is every name in play right now, so the word handed to a loser is not one
    // the session two rows down is already wearing - free with a counter, which nothing
    // else is ever called, but not with a word out of the prompt, which is exactly the
    // kind of word a neighbouring tab may hold.
    const taken = new Set(all.map((s) => s.name));
    const kept = new Set();
    for (const s of all) {
        if (!kept.has(s.name)) { kept.add(s.name); continue; }
        let fixed = '';
        // A scanned placeholder has a whole prompt behind it, so it gives up its word
        // for another one of its own rather than for a lookalike. A name somebody CHOSE
        // - typed, /renamed, or picked by the verifier, all of which set aiNamed - keeps
        // the counter: that word was chosen for this task, and swapping it out is not
        // deduplication.
        if (!s.aiNamed && s.prompt)
            for (const w of goodWords(s.prompt))
                if (w && !taken.has(w)) { fixed = w; break; }
        for (let n = 2; n < 100 && !fixed; n++) {
            const cand = s.name.slice(0, 12) + n;
            if (!taken.has(cand)) fixed = cand;
        }
        if (!fixed) fixed = s.id.slice(0, 8);
        shared.nlog('name clash: "' + s.name + '" -> "' + fixed + '"');
        s.name = fixed;
        taken.add(fixed);
        kept.add(fixed);
        if (s.aiNamed) naming.cacheName(s.id, fixed);
    }
}

// A response is over only when the API said so. Anything else on the newest record -
// "tool_use" (a call is coming), null (still streaming), "max_tokens"/"pause_turn"
// (the CLI continues by itself) - means the turn is still running.
const TERMINAL_STOPS = new Set(['end_turn', 'stop_sequence', 'refusal']);

// A slash command handled entirely by the CLI (/model, /login, /clear...) writes its
// echo into the transcript as a USER record and no turn ever follows it - there is
// nothing for Claude to answer. Left as the newest record it used to read as "a prompt
// went in", i.e. 🟢 working for ever. It is not a state at all: skip it and let the
// record before it say where the session actually stands.
// (/model writes THREE such records - the caveat, the command, then its stdout - so
// all three have to be seen through to reach the turn that actually ended.)
const LOCAL_ECHO = /^<(local-command-stdout|local-command-stderr|local-command-caveat|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)>/;

/// How long a submitted prompt has gone WITHOUT ANY REPLY, in ms (0 when the newest
/// record is not an unanswered prompt). This is the one window the transcript cannot
/// resolve on its own: a prompt that was submitted and then cancelled with Esc/Ctrl+C
/// before the first token leaves NO "[Request interrupted by user]" marker behind - the
/// user record just sits there, identical to one whose answer is still coming. Time is
/// the only thing that separates them, and only in this narrow window: it measures the
/// model's time to its FIRST record, never a long tool call (by then the newest record
/// is an assistant one and the normal stop_reason rules apply). Across this machine's
/// 1320 answered prompts the slowest first record took 296s, so minutes of grace still
/// cannot mistake a live turn for a cancelled one.
function noReplyAge(s) {
    return s && s.awaitingReply && s.sentAt ? Date.now() - s.sentAt : 0;
}

function noReplyMs() {
    const n = Number(shared.cfg().get('noReplyMinutes'));
    return Math.max(0, isFinite(n) ? n : 5) * 60_000;
}

/// The light gives up on an unanswered prompt at noReplyMinutes; the GEARS wait twice
/// that before they stop counting it as work. Getting a light wrong costs nothing and
/// is undone by the next write - powering the machine down on a turn that was merely
/// slow does not undo, so the side that can act keeps the wider margin.
function noReplyGaveUp(s) {
    const t = noReplyMs();
    return t > 0 && noReplyAge(s) >= t;
}

function noReplyDead(s) {
    const t = noReplyMs();
    return t > 0 && noReplyAge(s) >= t * 2;
}

/// Classify from the newest main-thread record. The reliable "this turn is over"
/// signal is the record's own `message.stop_reason`, NOT the absence of a tool_use
/// block: Claude Code writes one record per content block, so a turn that thinks,
/// says something, then calls a tool leaves text-only records behind mid-turn. Across
/// this machine's last week of transcripts 4850 such records carried stop_reason
/// "tool_use" (still working) against 343 genuine "end_turn" ones - i.e. the old
/// no-tool-block test was wrong 14 times out of 15, which is exactly what the minutes
/// of quiet time used to paper over. stop_reason is present on every assistant record
/// (12536/12536 checked), so there is no heuristic left to fall back to.
///
/// On top of that, "awaiting" splits into QUESTION (Claude wants a decision: an
/// AskUserQuestion multiple-choice, a plan approval, or a reply ending in "?") vs
/// plain done - the question flag is what makes the light 🟠 instead of 🔴.
/// How far back parseTail reads. The window exists so a 40 MB transcript is not read
/// end to end every scan - the answer is always in the last few records. But a record
/// is ONE LINE, and a pasted screenshot or an image-returning tool result is stored as
/// base64 inside it, so a single record can be bigger than the window: 6% of the
/// transcripts on this machine hold one, the largest 1.2 MB. When that lands last, the
/// window contains no complete line at all and the tail says nothing about the turn -
/// which used to read as 'unknown', and 'unknown' counts as FINISHED (shutdown.js).
/// That is a machine powering off mid-turn because a screenshot was pasted, so the
/// retry window is big enough to swallow any realistic record...
const TAIL_BYTES = 256 * 1024;
const TAIL_RETRY_BYTES = 8 * 1024 * 1024;

/// ...and past that, the state is 'unparsed', NOT 'unknown': we could not see, which
/// is not the same as nothing to see. isFinished() treats it as busy.
/// Returns true when the tail was actually READ - whatever it turned out to say - and
/// false when the file could not be opened at all. The caller uses that to decide
/// whether the verdict is worth caching against the file's mtime.
function parseTail(s) {
    const meta = {};
    if (parseTailWindow(s, TAIL_BYTES, meta)) return true;
    // A failed read leaves truncated set too, so the retry runs - which is worth doing:
    // EBUSY against a file claude is mid-append to often clears within the same tick.
    if (meta.truncated && parseTailWindow(s, TAIL_RETRY_BYTES, meta)) return true;
    if (meta.failed) {
        // Still unreadable after the retry. 'unparsed' is the fail-safe answer - the one
        // isFinished() counts as busy - and it must be set rather than left alone: a
        // session first seen on a failing read has no previous verdict to fall back on,
        // and its default is the 'unknown' that powers the machine off. The mtime is
        // deliberately NOT cached (see scanSessions), so the next tick tries again.
        s.state = 'unparsed';
        return false;
    }
    s.question = false;
    s.interrupted = false;
    s.awaitingReply = false;
    if (meta.truncated) {
        // A window that never reached the start of the file and still yielded nothing:
        // the answer is off the end of what we read. Say so instead of guessing.
        s.state = 'unparsed';
        return true;
    }
    // The whole file, and no turn in it: a claude tab that was opened, maybe had
    // /model run in it, and never prompted. THAT is nothing to wait for.
    s.state = 'unknown';
    return true;
}

/// How many records past the state verdict the tail keeps reading to find the newest
/// thing the USER typed (s.lastPrompt, the hover's "latest" line). The prompt is rarely
/// the newest record - a tool-heavy turn puts hundreds of tool_use/tool_result pairs
/// after it - but reading the whole 256 KB window on every transcript change, for one
/// line in a hover, is not worth it. Past this many records the previous parse's answer
/// stands, which is the right answer anyway: the prompt has not changed if no new one
/// went in.
const PROMPT_LOOKBACK = 300;

/// The tail parse over one window. Returns true when it found a main-thread record and
/// set the state from it; false when the window held nothing that says anything.
///
/// TWO answers come out of the one pass. The newest main-thread record decides the
/// STATE and is the whole job for that; the newest thing the user actually TYPED is
/// usually further back, so once the state is settled (`decided`) the loop keeps
/// walking backwards for it rather than reading the window a second time.
function parseTailWindow(s, bytes, meta) {
    let decided = false;
    let prompt = '';
    let extra = 0;
    // THE MODEL, straight from the transcript. Every assistant record names the model
    // that wrote it, so the session says what is actually running in it - including a
    // mid-session /model switch, which nothing on our side ever sees. Lines arrive
    // newest-first, so the first one that names a model is the current one.
    let gotModel = false;
    // ...and the CWD, on the same rule and for the same reason. The loop goes on past
    // the verdict for up to PROMPT_LOOKBACK older records, so taking the last cwd seen
    // took the OLDEST one: a session resumed with `claude --resume` from another folder
    // appends to the same transcript, and the stale cwd is what underWorkspace() would
    // then judge it by - dropping the session as foreign, or adopting it into the wrong
    // workspace. Newest-first, so the first one wins.
    let gotCwd = false;
    for (const line of readTailLines(s.file, bytes, meta)) {
        if (decided && ++extra > PROMPT_LOOKBACK) break;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || typeof rec !== 'object') continue;
        if (rec.isSidechain === true) continue;
        if (rec.type !== 'user' && rec.type !== 'assistant') continue;
        if (!gotCwd && typeof rec.cwd === 'string' && rec.cwd) { s.cwd = rec.cwd; gotCwd = true; }
        const msg = rec.message;
        if (!msg || typeof msg !== 'object') continue;
        if (!gotModel && rec.type === 'assistant' && typeof msg.model === 'string' && msg.model) {
            s.model = msg.model;
            gotModel = true;
        }

        let hasToolUse = false;
        let askTool = false;
        let hasToolResult = false;
        let text = '';
        const content = msg.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content))
            for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                if (block.type === 'tool_use') {
                    hasToolUse = true;
                    // These tools BLOCK on the user - a pending one is a question,
                    // not background work.
                    if (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode')
                        askTool = true;
                } else if (block.type === 'tool_result') hasToolResult = true;
                else if (block.type === 'text' && typeof block.text === 'string') text += block.text;
            }

        // A local slash command's echo - and anything else the CLI injects rather than
        // the user typing it - says nothing about the session: keep looking.
        if (rec.type === 'user' && (rec.isMeta === true || LOCAL_ECHO.test(String(text || '').trim())))
            continue;

        const trimmed = String(text || '').trim();
        const interrupted = /^\[Request interrupted by user/.test(trimmed);
        // What the USER typed, as opposed to what the CLI wrote as a user record: not a
        // mid-turn tool_result, not the interrupt marker below, not an attachment or a
        // wrapper blob (firstPrompt skips a leading '<' for the same reason). Captured
        // before the verdict block, so a prompt that IS the newest record still counts.
        if (!prompt && rec.type === 'user' && !hasToolResult && !interrupted &&
            trimmed && !trimmed.startsWith('<'))
            prompt = shared.flat(text, 200);
        if (decided) { if (prompt && gotModel) break; continue; }

        s.lastText = shared.flat(text, 800);
        // A turn cut short - Escape, or the window/terminal dying mid-turn - leaves
        // "[Request interrupted by user]" as the newest main-thread record. Claude is
        // idle, NOT working: the session is awaiting input, and the interrupted flag
        // is what makes its light 🟠 rather than a 🔴 that pretends the turn finished.
        if (interrupted) {
            s.state = 'awaiting';
            s.question = false;
            s.interrupted = true;
            s.awaitingReply = false;
            decided = true;
            if (prompt && gotModel) break;
            continue;
        }
        s.interrupted = false;
        // A PROMPT with no answer after it (not a tool_result, which is mid-turn by
        // definition): the turn either has not produced its first record yet, or it was
        // cancelled before it ever did. noReplyAge() is what tells those apart later.
        s.awaitingReply = rec.type === 'user' && !hasToolResult;
        s.sentAt = s.awaitingReply ? (Date.parse(rec.timestamp) || Date.now()) : 0;
        if (rec.type === 'assistant' && askTool) {
            // These block on the user even though the response ended with "tool_use".
            s.state = 'awaiting';
            s.question = true;
        } else {
            s.state = rec.type === 'assistant' && !hasToolUse && TERMINAL_STOPS.has(msg.stop_reason)
                ? 'awaiting' : 'working';
            s.question = s.state === 'awaiting' && /\?\s*$/.test(trimmed);
        }
        decided = true;
        if (prompt && gotModel) break;
    }
    if (!decided) return false;
    // Nothing typed inside the window (or inside PROMPT_LOOKBACK of the tail) means the
    // last prompt is OLDER than what was read, not that there isn't one - so keep
    // whatever an earlier parse found rather than blanking the hover mid-turn.
    if (prompt) s.lastPrompt = prompt;
    return true;
}

// ------------------------------------------------------- background agents
//
// Sub-agents (the Agent tool) and workflow stages each write their own transcript -
// agent-*.jsonl under the session's sidecar dir - in exactly the main transcript's
// format. So "is the fleet still working?" has the same honest answer as the main
// thread: read each tail's own stop_reason. An agent sitting in a long tool call
// writes nothing for a minute and is very much working; one whose newest record says
// end_turn is done however fresh the file looks.

/// Longest silent stretch a LIVE agent can produce: a maxed-out 10-minute tool call,
/// plus margin. A working-tail agent file older than this is dead where it stands -
/// its process was killed or crashed - and must not hold the gears shut for ever.
const AGENT_DEAD_MS = 15 * 60_000;

/// An agent that finishes owes the main thread a task-notification, which lands as a
/// new user record and starts a new turn a few seconds later. Until it lands the
/// session is NOT finished - the chime once beat one by under a second - so a fresh
/// completion keeps the session busy this long, or until the main transcript is
/// written past it, whichever comes first.
const NOTIFY_GRACE_MS = 15_000;

/// How long after a session's last write - main transcript OR sidecar - its agent
/// files are still worth walking. Past AGENT_DEAD_MS nothing under there can be alive,
/// so the answer cannot change until the session writes again.
const SIDECAR_WINDOW_MS = AGENT_DEAD_MS + 60_000;

/// Is any of this session's background agents still working? Tails are cached per
/// file by mtime, so the once-a-second scans only re-read agents that actually wrote.
function backgroundBusy(s, sideDir, transcriptMs) {
    const now = Date.now();
    if (!s.agentTails) s.agentTails = new Map();
    let busy = false;
    let newestDone = 0;
    for (const { file, mtime } of agentFiles(sideDir)) {
        if (now - mtime >= AGENT_DEAD_MS) continue;      // dead, not busy
        let tail = s.agentTails.get(file);
        if (!tail || tail.mtime !== mtime)
            s.agentTails.set(file, tail = { mtime, working: agentWorking(file) });
        if (tail.working) busy = true;
        else newestDone = Math.max(newestDone, mtime);
    }
    // Every agent finished, but the newest completion is younger than the last main-
    // thread write: its task-notification is still on its way.
    return busy || (newestDone > transcriptMs && now - newestDone < NOTIFY_GRACE_MS);
}

/// One authoritative sidecar walk for the given sessions, ignoring the window above.
///
/// That window is right for the lights - past SIDECAR_WINDOW_MS of total silence
/// nothing under there can be alive, so the walk stops and the cost goes away. But it
/// can only START again on a write to the MAIN transcript, and a background agent
/// writes only its own: an Agent call that goes quiet through a long tool call, past
/// the window, and then resumes leaves the session reading "finished" until its
/// completion notification lands on the main thread. Every caller can afford to be
/// wrong about that for a minute except one - the armed shutdown, which would power
/// the machine off mid-agent - so that one pays for a real walk, once, at the moment
/// it would otherwise fire. Returns true if anything is still working.
function recheckBackground(sessions) {
    let busy = false;
    for (const s of sessions || []) {
        if (!s || !s.dir || !s.id) continue;
        const sideDir = path.join(s.dir, s.id);
        const side = Math.max(newestUnder(sideDir), newestUnder(path.join(shared.TASKS, s.id)));
        if (side) {
            s.lastSideMs = Math.max(s.lastSideMs || 0, side);
            if (side > s.lastWriteMs) s.lastWriteMs = side;
        }
        // The notification grace inside backgroundBusy is measured against the MAIN
        // transcript, not against lastWriteMs - which the sidecar has just pushed.
        let mainMs = 0;
        try { mainMs = fs.statSync(s.file).mtimeMs; } catch { }
        s.background = backgroundBusy(s, sideDir, mainMs);
        if (s.background) busy = true;
    }
    return busy;
}

/// The agent transcripts under a session's sidecar dir - one agent-*.jsonl per
/// background Agent call or workflow stage. journal/meta/tool-result files are not
/// transcripts and are skipped.
function agentFiles(root, cap = 400) {
    const out = [];
    const stack = [root];
    while (stack.length && out.length < cap) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (out.length >= cap) break;
            const p = path.join(cur, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (!/^agent-.*\.jsonl$/.test(e.name)) continue;
            try { out.push({ file: p, mtime: fs.statSync(p).mtimeMs }); } catch { }
        }
    }
    return out;
}

/// parseTail's little sibling for an agent transcript: is its turn still running?
/// The same reading - the newest record's own stop_reason - minus the question and
/// no-reply business that only matters for a session a user is sitting in front of.
/// (Agent records are all marked isSidechain, so that filter does not apply here.)
function agentWorking(file) {
    for (const line of readTailLines(file, 64 * 1024)) {
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
        const msg = rec.message;
        if (!msg || typeof msg !== 'object') continue;
        let text = '';
        const content = msg.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content))
            for (const b of content)
                if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
        if (/^\[Request interrupted by user/.test(text.trim())) return false;
        // A tool_result the CLI stamped `toolEndsTurn` is the END of the agent, not the
        // middle of it: an agent given a schema (`agent(..., {schema})`) answers by CALLING
        // StructuredOutput, and the tool_result acknowledging that call is the last record
        // its transcript ever gets - there is no assistant `end_turn` behind it. Read as a
        // bare user record it said 'still working' for ever, so every finished workflow
        // agent went on holding its session 🟢 'processing (background work)' - and the
        // chime and the armed shutdown with it - until the file aged past AGENT_DEAD_MS.
        if (rec.type === 'user' && rec.toolEndsTurn === true) return false;
        if (rec.type === 'user') return true;    // its prompt, or a mid-turn tool_result
        return !TERMINAL_STOPS.has(msg.stop_reason);
    }
    return false;    // empty or unreadable - nothing to wait for
}

/// The session's first real user prompt - it becomes the traffic light's name.
function firstPrompt(file) {
    let head = '';
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(64 * 1024);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.toString('utf8', 0, n);
        } finally { fs.closeSync(fd); }
    } catch { return ''; }

    for (const line of head.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let rec;
        try { rec = JSON.parse(t); } catch { continue; }
        if (!rec || rec.type !== 'user' || rec.isSidechain === true || rec.isMeta === true) continue;
        const content = rec.message && rec.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content))
            for (const block of content)
                if (block && block.type === 'text' && typeof block.text === 'string') text += block.text + ' ';
        text = shared.flat(text, 200);
        if (!text || text.startsWith('<')) continue;   // command/meta wrappers
        return text;
    }
    return '';
}

function firstWord(prompt) {
    const w = String(prompt || '').split(/\s+/)[0] || '';
    const clean = w.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}]+$/gu, '');
    const word = clean || w;
    return word.length > 14 ? word.slice(0, 14) + '…' : word;
}

// Words that never identify a task on their own - articles, pronouns, filler, and the
// generic verbs every prompt shares ("fix", "update", "file"...).
const STOPWORDS = new Set(('the a an and or but so of to in on for with at by from up out off over ' +
    'under again can cant could couldnt should shouldnt would wouldnt will wont just please pls we ' +
    'i you it its is are was were be been being do does did done not no yes my our your this that ' +
    'these those there here what when where which who whose how why me us them they then than into ' +
    'onto about as if else while make makes made making let lets want wants wanted need needs ' +
    'needed like likes liked get gets got getting give gives gave have has had having very really ' +
    'quite some any all more most now new also still too only even well going good great bad ok ' +
    'okay hi hello hey thanks thank fix fixes fixed fixing update updates updated add adds added ' +
    'adding change changes changed changing file files folder page thing things stuff way bit lot ' +
    'use using used try tries trying tried look looks looking looked see sees seems seemed ' +
    'something anything everything nothing dont doesnt didnt isnt arent wasnt werent youre theyre ' +
    'im ive weve after before first last next one two other another little much many few take ' +
    'takes took put puts run runs running ran work works working worked right left same each per ' +
    'via keep keeps keeping instead maybe actually help').split(' '));

/// Scan the WHOLE original question for distinctive words - not whatever happens to sit
/// first ("the", "can"...). Stopwords are dropped; the first dozen survivors are ranked
/// longest first (earliest on ties), so [0] is the placeholder - already a real task
/// word before the AI verifier ever runs - and the rest are what a tab whose word is
/// already taken falls back to instead of a counter. goodWord below does that walk;
/// naming.js takes the whole list when the model hands back a name somebody else has.
function goodWords(prompt) {
    const cands = String(prompt || '').toLowerCase().split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOPWORDS.has(w))
        .map((w) => w.slice(0, 14));
    // A word the question repeats is one candidate, not three - and it is deduped BEFORE
    // the twelve-word window, so a repeat cannot spend a slot a later word could have
    // had. "fix the parser, then the parser tests, then the parser fixture..." used to
    // put `parser` in four of the twelve and push the alternates that a collision falls
    // back on (goodWord below) off the end, straight onto the counter.
    const ranked = [...new Set(cands)].slice(0, 12)
        .map((w, i) => ({ w, i }))
        .sort((a, b) => (b.w.length - a.w.length) || (a.i - b.i))
        .map((c) => c.w);
    return ranked.length ? ranked : [firstWord(prompt)].filter(Boolean);
}

/// The name this prompt earns for session `id`: the ranked words above are walked in
/// order and the first one no other tab is wearing wins. "parser" taken means the tab
/// is called "comments", not "parser2" - a digit says nothing about the task, and the
/// one pair of tabs anybody misreads at a glance is `x` and `x2`. Only a question with
/// every one of its words already worn reaches the counter, on the best of them
/// (shared.uniqueName does the walking and owns that last resort).
///
/// The walk lives HERE, not at the call site: the placeholder path used to spell it out
/// as `words[0]` plus `words.slice(1)`, which reads as list plumbing rather than as the
/// rule it is, and left nothing for the next caller that wants a name out of a prompt.
function goodWord(prompt, id) {
    const words = goodWords(prompt);
    // No session to name for: the ranked head, and no dedupe walk. uniqueName(undefined)
    // would do two silent wrong things instead - its `s.id !== id` filter would count
    // the caller's OWN current word as taken and walk away from it, and both of its
    // fall-backs (no word at all, and a hundred collisions) name the tab from the id:
    // String(undefined).slice(0, 8), which is the literal word "undefine".
    if (!id) return words[0] || '';
    return shared.uniqueName(id, words[0], words.slice(1));
}

/// The last `maxBytes` of the file as complete lines, newest first. `meta` (optional)
/// comes back with `truncated`: true when the window did NOT reach the start of the
/// file, so an empty result means "could not see that far", not "nothing there" - the
/// distinction parseTail needs and used to have no way to ask for.
///
/// `failed` is the same distinction for the I/O itself. An open/read that throws also
/// yields no lines, and reporting THAT as "I read the whole file and it was empty" is
/// how an unreadable transcript used to come back 'unknown' - which the gears count as
/// finished. EBUSY (a virus scanner holding the handle while claude appends), EMFILE,
/// or ENOENT from a rotation between the statSync in scanSessions and this open are all
/// ordinary on Windows, so the failure is stated rather than flattened into a verdict.
function readTailLines(file, maxBytes, meta) {
    if (meta) { meta.truncated = false; meta.failed = false; }
    let text = '';
    let start = 0;
    try {
        const fd = fs.openSync(file, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const take = Math.min(maxBytes, size);
            start = size - take;
            const buf = Buffer.alloc(take);
            const n = fs.readSync(fd, buf, 0, take, start);
            text = buf.toString('utf8', 0, n);
        } finally { fs.closeSync(fd); }
    } catch {
        // truncated as well as failed: "we did not reach the start of the file" is true
        // of a read that never happened, and it is what routes parseTail away from the
        // 'unknown' branch below.
        if (meta) { meta.truncated = true; meta.failed = true; }
        return [];
    }
    if (meta) meta.truncated = start > 0;
    let lines = text.split('\n');
    if (start > 0) lines = lines.slice(1);            // partial first line
    return lines.map((l) => l.trim()).filter((l) => l.startsWith('{')).reverse();
}

function newestUnder(dir, cap = 1500) {
    let newest = 0;
    let seen = 0;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (++seen > cap) return newest;
            const p = path.join(cur, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            try {
                const t = fs.statSync(p).mtimeMs;
                if (t > newest) newest = t;
            } catch { }
        }
    }
    return newest;
}

Object.assign(module.exports,
    { scanSessions, underWorkspace, mayHoldOurs, noReplyAge, noReplyGaveUp, noReplyDead,
      applyCliStatus, adoptCliName, recheckBackground, goodWord, goodWords, AGENT_DEAD_MS });

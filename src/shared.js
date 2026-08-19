// Shared state + small helpers - the one place every section reaches for the
// session/terminal maps, the status bar items created in activate(), and the few
// utilities used across sections. Everything else lives in its section's module.

const vscode = require('vscode');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const TASKS = path.join(os.homedir(), '.claude', 'tasks');
// Written by every RUNNING claude CLI - <pid>.json, carrying its own sessionId and
// cwd. The one place a tab's process can be turned into the session it is running.
const SESSIONS = path.join(os.homedir(), '.claude', 'sessions');

const sessions = new Map();   // sessionId -> session record (see scan.js)
const suppressed = new Map(); // sessionId -> transcript mtime when its tab was closed
const termRecs = new Map();   // terminal name -> {name, terminal, item, lines, exited, ended, exitCode, command, cwd}
const claudeRecs = [];        // claude terminals WE created: {terminal, cwd, created, sessionId, lastTitle, inEditor}

// Status bar items, created in extension.js activate(): toggle, stop, namer,
// stale, usage.
const items = {};

const state = { extContext: null, ready: false };  // for globalState (AI name cache)

const cfg = () => vscode.workspace.getConfiguration('chutdown');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = (s) => Date.now() - s.lastWriteMs;

function firstRoot() {
    const ws = vscode.workspace.workspaceFolders;
    return ws && ws.length ? ws[0].uri.fsPath : os.homedir();
}

function normCwd(p) { return (p || '').replace(/[\\/]+$/, '').toLowerCase(); }

// The claude tab icon: the Chutdown "C" (open ring + power bar) as a light/dark SVG
// pair, sitting where the `blank` codicon used to leave the tab with no mark at all.
// The files live in media/, one level up from src/.
//
// A tab launched for a KNOWN model wears that model's letter instead - the very same
// O / F / S / H resources the editor title buttons use, so the mark on the tab is the
// mark on the button that opened it. VS Code freezes iconPath at createTerminal time,
// so this can only ever say what we KNEW when the tab was made: what we launched, or -
// for a resumed session - the model the transcript's newest assistant record names
// (scan.js reads it, resumeSession passes it). A hand-typed custom model and the +
// dropdown profile still keep the "C".
const ICONS = path.join(__dirname, '..', 'media');
const LETTER_ICONS = new Set(['o', 'f', 's', 'h']);
function claudeIcon(letter) {
    const l = String(letter || '').toLowerCase();
    const base = LETTER_ICONS.has(l) ? 'letter-' + l : 'tab-claude';
    return {
        light: vscode.Uri.file(path.join(ICONS, base + '-light.svg')),
        dark: vscode.Uri.file(path.join(ICONS, base + '-dark.svg'))
    };
}

// ------------------------------------------- one name, one tab
//
// Two sessions must NEVER wear the same name: the light, the tab title, the shutdown
// warning and every dropdown row identify a session by that word alone, so a twin
// makes the user pick blind. EVERY name assigned anywhere goes through here - if
// another live session already wears the word, a counter is appended (fleet, fleet2).
/// `alts` - other words that would identify this session, best first, tried before the
/// counter. A scanned placeholder has a WHOLE PROMPT behind it, so a tab whose best word
/// is already worn takes the next distinctive word from its own question ("parser")
/// rather than a lookalike of somebody else's tab ("review2"): two tabs one digit apart
/// are exactly the pair that gets misread at a glance, and the digit says nothing about
/// the task. The counter stays as the last resort - some prompts really do only carry
/// one usable word.
function uniqueName(id, base, alts) {
    const word = String(base || '').slice(0, 14) || String(id).slice(0, 8);
    const taken = new Set();
    for (const s of sessions.values()) if (s.id !== id && s.name) taken.add(s.name);
    if (!taken.has(word)) return word;
    for (const raw of alts || []) {
        const cand = String(raw || '').slice(0, 14);
        if (cand && cand !== word && !taken.has(cand)) return cand;
    }
    for (let n = 2; n < 100; n++) {
        const cand = word.slice(0, 12) + n;
        if (!taken.has(cand)) return cand;
    }
    return String(id).slice(0, 8);
}

// ------------------------------------------- untrusted text in a trusted hover
//
// Every hover in this extension sets `isTrusted` - it has to, or the Close / Copy
// links in it are inert. In a trusted MarkdownString `[x](command:some.command?args)`
// renders as a live link that runs that command with those arguments on one click.
// And the hovers are FULL of text nobody here wrote: the first prompt, the assistant's
// last answer, a dev server's log lines. Pasted text, a package's postinstall banner,
// a request path echoed by a server - any of it can carry markdown.
//
// Two halves, and both are needed. `mdText` escapes the text so it cannot become a
// link; `isTrusted: { enabledCommands: [...] }` (used at every hover) means that even
// if something did get through, the only commands it could name are Chutdown's own
// harmless ones - not `workbench.action.terminal.sendSequence`.

/// Markdown-escape a run of untrusted text for use inside appendMarkdown.
function mdText(raw) {
    return String(raw == null ? '' : raw).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/// A fenced code block whose fence is longer than any backtick run in the content, so
/// output containing ``` cannot close it early and escape into trusted markdown.
/// (MarkdownString.appendCodeblock always uses exactly three backticks, which is why
/// this is here rather than there.)
function mdCode(raw, lang) {
    const text = String(raw == null ? '' : raw);
    const longest = (text.match(/`+/g) || []).reduce((m, run) => Math.max(m, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return fence + (lang || '') + '\n' + text + '\n' + fence + '\n';
}

function flat(raw, max) {
    const f = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ').trim();
    return f.length > max ? f.slice(0, max) + '…' : f;
}

function humanize(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 5) return 'now';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

// ------------------------------------------------- writing a status bar item
//
// A StatusBarItem setter RE-RENDERS the item even when it is handed the value it already
// holds - and a re-render closes the hover the user is in the middle of reading. The 5s
// poll assigned every item's text, tooltip and show() on every pass, so every hover in
// the extension twitched shut every five seconds, with nothing on screen having changed.
//
// So nothing is written directly any more: `paint` compares what the item would become
// against what it was last painted with, and if they are the same it does nothing at all.
// (The tooltip is usually a MarkdownString, which is a FRESH OBJECT every time even when
// the text is identical - hence comparing `.value`, not the object.)
//
// The other half of a still hover is CONTENT that does not churn: a "quiet 3m 12s" that
// ticks every five seconds defeats this on its own, however carefully it is written. Use
// `coarse` for durations in a hover - it changes once a minute at most - and a clock time
// rather than an age where the exact number matters (usage.js does this).
const painted = new WeakMap();

/// Returns whether anything was actually written - handy in a log line, ignorable
/// otherwise. Only the keys present in `spec` are touched.
function paint(item, spec) {
    const tip = spec.tooltip;
    const key = [
        spec.text || '',
        tip && tip.value !== undefined ? tip.value : (tip || ''),
        spec.backgroundColor ? spec.backgroundColor.id : '',
        spec.color ? spec.color.id : ''
    ].join('\0');
    if (painted.get(item) === key) return false;
    painted.set(item, key);
    if ('text' in spec) item.text = spec.text;
    if ('tooltip' in spec) item.tooltip = tip;
    if ('backgroundColor' in spec) item.backgroundColor = spec.backgroundColor;
    if ('color' in spec) item.color = spec.color;
    item.show();
    return true;
}

/// Hiding forgets the last paint, so the item is written again when it comes back -
/// otherwise an item hidden and re-shown with identical content would never re-appear.
function unpaint(item) {
    painted.delete(item);
    item.hide();
}

/// A duration for a HOVER: coarse on purpose, so it does not change under the pointer.
/// `humanize` is still the right thing for a notification or a log line, which are
/// written once and never re-rendered.
function coarse(ms) {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return 'under a minute';
    if (sec < 3600) return Math.floor(sec / 60) + ' min';
    const h = Math.floor(sec / 3600);
    return h + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
}

// ------------------------------------------- dismissals survive a reload
//
// A session dismissed (tab closed, or "Close" clicked on its light) used to come
// BACK as a light after every window reload, because `suppressed` only ever lived in
// memory - which is exactly why a reload used to bring a row of white lights with it.
// The receipt is the transcript mtime at dismissal, so a genuine resume still writes
// past it and earns its light back.

const SUPPRESS_KEY = 'dismissedSessions';
const SUPPRESS_MAX_AGE = 30 * 24 * 3_600_000;

function saveSuppressed() {
    if (!state.extContext) return;
    const map = {};
    for (const [id, mtime] of suppressed) map[id] = mtime;
    state.extContext.workspaceState.update(SUPPRESS_KEY, map);
}

function loadSuppressed() {
    if (!state.extContext) return;
    const map = state.extContext.workspaceState.get(SUPPRESS_KEY) || {};
    const floor = Date.now() - SUPPRESS_MAX_AGE;
    for (const id of Object.keys(map)) {
        const mtime = map[id];
        if (typeof mtime === 'number' && mtime >= floor) suppressed.set(id, mtime);
    }
}

let outChannel = null;

function nlog(msg) {
    if (!outChannel) outChannel = vscode.window.createOutputChannel('Chutdown');
    outChannel.appendLine(new Date().toLocaleTimeString() + '  ' + msg);
}

/// Created lazily on the first log line, so it cannot be pushed to
/// context.subscriptions at activation - extension.js disposes it through this
/// instead, or the channel outlives the extension in the Output dropdown.
function disposeLog() {
    if (outChannel) { outChannel.dispose(); outChannel = null; }
}

// ------------------------------------------- the startup spinner
//
// Chutdown activates in the FIRST wave ("*" in package.json), which on a cold start can
// be a good while before the workbench has finished coming back: transcripts unread,
// terminals not restored yet, nothing to draw. Rather than an empty gap in the status
// bar where the lights belong, a spinner sits there until every gate below has reported
// in - the first render of the lights, and the one-off pass that matches the restored
// tabs back to their sessions. Whoever finishes last takes the spinner away.
const gates = new Set();

/// Declared at activation, before the work behind them starts.
function addGate(gate) { if (!state.ready) gates.add(gate); }

function clearGate(gate) {
    if (!gates.delete(gate) || gates.size) return;
    state.ready = true;
    if (items.loading) { items.loading.dispose(); items.loading = null; }
    nlog('ready');
}

Object.assign(module.exports, {
    PROJECTS, TASKS, SESSIONS, sessions, suppressed, termRecs, claudeRecs, items, state,
    cfg, sleep, quiet, firstRoot, normCwd, claudeIcon, uniqueName, flat, humanize, coarse,
    paint, unpaint, nlog,
    mdText, mdCode, disposeLog, saveSuppressed, loadSuppressed, addGate, clearGate
});

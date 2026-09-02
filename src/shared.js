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

// ------------------------------------------- reading a NUMBER out of settings
//
// VS Code does NOT coerce a setting that violates the contributed schema: a string
// ("2m"), a null, an empty box in the settings UI arrives at get() exactly as written.
// `Number("2m")` is NaN, and NaN poisons every comparison it touches SILENTLY - which
// is how one typo in settings.json used to turn a threshold off rather than complain:
//   Math.max(0, NaN) * 60_000     -> NaN, and `quiet(s) < NaN` is false for everything
//   Math.max(0, Number(x) || 0)   -> 0, and 0 usually means "this check is off"
// The second shape is the dangerous one, because it fails OPEN on the armed gear: a
// mistyped questionMinutes read as 0, and 0 means "questions never hold the shutdown
// up", so the machine could power down over a live question - the one path that does
// not undo.
//
// So every numeric setting is read through here instead. A usable value is clamped to
// `min` and returned unchanged; an unusable one falls back to the setting's OWN default
// (never to 0) and says so once in the output channel, naming the setting - a threshold
// that quietly did nothing is exactly the bug nobody reports.
//
// scan.js (lookbackMs, noReplyMs, shellMs), answer.js (delayMs), density.js (budget)
// and shutdown.js (settleMs, countdownSeconds) already clamp inline in this spirit;
// this is that rule with one implementation and a log line.

/// key -> the unusable raw value already reported, so a broken setting is logged once
/// rather than on every 5s poll. A value that becomes usable again clears its entry,
/// so a SECOND typo is still reported.
const badCfg = new Map();

/// Read a numeric setting. `def` is the value's contributed default in package.json,
/// used whenever the configured value is missing or unusable; `min` is the floor a
/// usable value is clamped to (default 0).
/// Returns a finite number, always.
function cfgNum(key, def, min) {
    const floor = min === undefined ? 0 : min;
    const raw = cfg().get(key);
    const n = Number(raw);
    const usable = raw !== null && raw !== undefined && raw !== '' && isFinite(n);
    if (!usable) {
        // undefined = simply not set, which is not a mistake and not worth a line.
        if (raw !== undefined) {
            let shown;
            try { shown = JSON.stringify(raw); } catch { shown = String(raw); }
            if (badCfg.get(key) !== shown) {
                badCfg.set(key, shown);
                nlog('setting chutdown.' + key + ' = ' + shown +
                    ' is not a number - using ' + def);
            }
        }
        return Math.max(floor, def);
    }
    badCfg.delete(key);
    return Math.max(floor, n);
}

function firstRoot() {
    const ws = vscode.workspace.workspaceFolders;
    return ws && ws.length ? ws[0].uri.fsPath : os.homedir();
}

function normCwd(p) { return (p || '').replace(/[\\/]+$/, '').toLowerCase(); }

// The claude tab MARK - the `iconPath` and `color` a claude terminal is created with.
// A tab launched for a KNOWN model wears that model's letter: O / F / S / H for the
// Claude models, S / T / L / M for the OpenAI ones (Sol and Sonnet share the letter -
// the colour tells the two S marks apart, which is the whole reason the letters carry
// one); a tab whose model nobody knows - the + dropdown profile, a hand-typed custom
// model - wears the Chutdown "C" (open ring + power bar).
//
// The mark is a GLYPH from our own icon font (media/chutdown.ttf, package.json
// `contributes.icons`, built by media/make-font.js from the same geometry as the
// media/letter-*.svg the editor title buttons draw), NOT the SVG pair it used to be.
// A terminal's icon is frozen at createTerminal time, and a file-URI icon does not
// survive a window reload at all: the reconnected tab comes back wearing the
// workbench's default mark (seen 2026-08-22 - four lettered tabs, four "≡"), and the
// only cure was to reopen the tab, which kills the claude in it and with it the Tab
// suggestion sitting in its prompt. A ThemeIcon is persisted by id and comes back as
// it was, so a reload costs nothing. The price is the colour: a terminal tab icon
// takes only the standard terminal.ansi* theme colours, so the tab letter wears the
// theme's ansiYellow (Claude) / ansiBlue (OpenAI) rather than the exact #E8936A /
// #8FC6FF the SVGs and the status bar use. Still, the mark can only say what we KNEW
// when the tab was made - what we launched, or for a resumed session the model the
// transcript names; a tab whose letter turns out wrong is reopened by
// claude.refreshTabMarks, and that is the one thing left that costs a reopen.
const GLYPHS = { claude: new Set(['o', 'f', 's', 'h']), openai: new Set(['s', 't', 'l', 'm']) };
const MARK_COLOR = { claude: 'terminal.ansiYellow', openai: 'terminal.ansiBlue' };
/// `vendor` is 'claude' (default) or 'openai'. Spread into createTerminal's options.
function tabMark(letter, vendor) {
    const l = String(letter || '').toLowerCase();
    const v = vendor === 'openai' ? 'openai' : 'claude';
    const id = GLYPHS[v].has(l) ? 'chutdown-letter-' + l : 'chutdown-c';
    return { iconPath: new vscode.ThemeIcon(id), color: new vscode.ThemeColor(MARK_COLOR[v]) };
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
    cfg, cfgNum, sleep, quiet, firstRoot, normCwd, tabMark, uniqueName, flat, humanize, coarse,
    paint, unpaint, nlog,
    mdText, mdCode, disposeLog, saveSuppressed, loadSuppressed, addGate, clearGate
});

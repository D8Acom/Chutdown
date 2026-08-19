// Traffic light items - one status bar entry per live session, the stale "idle"
// dropdown, and the Sessions & Terminals quick pick.

const vscode = require('vscode');

const shared = require('./shared');
const claude = require('./claude');
const batch = require('./batch');
const scan = require('./scan');
const naming = require('./naming');

const sessionItems = new Map(); // sessionId -> its own status bar traffic light
// Session lights sit between the .terminals/stop buttons above them and the idle
// entry at 903, and tick DOWN so a newer session lands to the right of an older one.
// A StatusBarItem's priority is fixed at creation, so this has to be picked before the
// item exists - and it used to be a bare `prio--` with no floor: leave one window open
// long enough for ~95 sessions to come and go and the next light was created at 902,
// i.e. to the right of the usage meter, then in among the batch terminal lights at
// 900-idx. It wraps within its own band now, skipping anything a live light still
// holds, so the documented status bar order survives a long-running window.
const PRIO_TOP = 997;
const PRIO_FLOOR = 905;         // 903 = idle, 902 = usage, 900-n = batch terminals
let prioCursor = PRIO_TOP;

const takenPrios = new Set();   // priorities held by a live session light
const itemPrios = new Map();    // sessionId -> the priority its light holds

function nextSessionPrio(id) {
    for (let i = 0; i <= PRIO_TOP - PRIO_FLOOR; i++) {
        if (prioCursor < PRIO_FLOOR) prioCursor = PRIO_TOP;
        const p = prioCursor--;
        if (!takenPrios.has(p)) { takenPrios.add(p); itemPrios.set(id, p); return p; }
    }
    return PRIO_FLOOR;          // every slot live at once: share the floor rather than sink below it
}

/// A disposed light gives its slot back, so a window that has seen hundreds of sessions
/// keeps reusing the same band instead of walking out of it.
function releasePrio(id) {
    const p = itemPrios.get(id);
    if (p === undefined) return;
    takenPrios.delete(p);
    itemPrios.delete(id);
}

/// USER'S mapping: 🟢 working, 🟠 Claude asked a QUESTION (multiple-choice, plan
/// approval, or a reply ending in "?") OR the turn was INTERRUPTED, 🔴 turn done -
/// ready to reprompt.
function lightFor(s) {
    const working = s.state === 'working' || s.background;
    if (working) {
        // A prompt that went in and got NO reply for minutes was almost certainly
        // cancelled (Esc/Ctrl+C before the first token writes no marker - scan.js), so
        // it stops pretending to be 🟢 work in progress.
        if (scan.noReplyGaveUp(s) && !s.background)
            return { e: '🟠', label: 'no reply to the last prompt (' +
                shared.humanize(scan.noReplyAge(s)) + ') - it was probably cancelled' };
        return { e: '🟢', label: s.background ? 'processing (background work)' : 'processing' };
    }
    if (s.state === 'awaiting') {
        if (s.interrupted) return { e: '🟠', label: 'interrupted - the last turn was cut short' };
        // Read from the CLI's own status file rather than the transcript, which cannot
        // see a question until it has been answered (scan.js). This is the state that
        // used to sit here as 🟢 processing.
        if (s.waiting) return { e: '🟠', label: 'waiting on you - a question, a plan, or a permission prompt' };
        return s.question ? { e: '🟠', label: 'asking a question' }
                          : { e: '🔴', label: 'ready to reprompt' };
    }
    if (s.state === 'unparsed')
        return { e: '⚪', label: 'cannot read the end of the transcript - treating it as still working' };
    return { e: '⚪', label: 'unknown' };
}

/// A session with NO terminal tab in this window, quiet long enough that nothing can
/// still be running it (the state after a reload, or after its window was closed).
/// Rather than leave it white, the transcript tail says which way it ended:
/// unfinished turn - the process died mid-tool-call, or the user hit Escape - is
/// 🟠 INTERRUPTED; a turn that actually completed is 🔴 ready to reprompt.
function orphanLight(s, why) {
    if (s.state === 'working')
        return { e: '🟠', label: 'interrupted mid-turn - ' + why };
    const { e, label } = lightFor(s);
    return { e, label: label + ' - ' + why };
}

/// Does a tab in THIS window actually run this session right now? An empty shell VS Code
/// restored after a quit does not count - it wears the name but has no claude behind it.
function runningHere(s) {
    return claude.hasLocalTerminal(s.id) && !claude.revivedTab(s.id);
}

/// How long a session with no tab here must stay quiet before it counts as orphaned
/// rather than "live in another window" - a transcript being written is the only
/// evidence some other window still holds it.
function orphanMs() {
    return Math.max(0, shared.cfg().get('orphanMinutes')) * 60_000;
}

/// Could anything still be RUNNING this session? A live terminal in this window can;
/// one with no tab here whose transcript is STILL BEING WRITTEN is held by another
/// window; anything else is dead where it stands - the process went away mid-turn and
/// the transcript will never move again. The gears use this too, so a session the
/// lights already draw as 🟠 interrupted can no longer be one the sound and the
/// shutdown sit waiting on (a crashed window used to block both of them forever).
/// `deadMs` is how long the silence has to run before "nothing is writing it" becomes
/// "nothing can be running it". The lights pass nothing and get orphanMinutes, which is
/// a display choice - the colour of a session this window has no tab for. The GEARS
/// pass scan.AGENT_DEAD_MS, because there the same call decides whether to power the
/// machine off, and a two-minute silence is an ordinary long tool call.
function couldStillBeRunning(s, deadMs) {
    // Except a prompt that has gone unanswered for twice the give-up time: a live tab
    // proves a session COULD run, not that this turn ever started. Without this the
    // one cancelled prompt held the sound and the shutdown back for ever.
    if (scan.noReplyDead(s) && !s.background) return false;
    if (claude.hasLocalTerminal(s.id) && !claude.revivedTab(s.id)) return true;
    return shared.quiet(s) < (deadMs === undefined ? orphanMs() : deadMs);
}

/// The color a session ACTUALLY shows here. A session with no terminal tab in this
/// window stays WHITE only while something is still WRITING its transcript - then the
/// color belongs to whichever other window holds it. Once it goes quiet nothing can
/// be running it, so the transcript decides: 🟠 interrupted, 🔴 finished.
/// A tab restored from a QUIT counts as no tab at all here: it is an empty shell, so
/// whatever the transcript stopped at is the truth about that session.
function resolve(s) {
    const revived = claude.revivedTab(s.id);
    const local = runningHere(s);
    if (local) return Object.assign({ local }, lightFor(s));
    if (shared.quiet(s) < orphanMs())
        return { local, e: '⚪', label: 'running in another window' };
    return Object.assign({ local }, orphanLight(s,
        revived ? 'its tab was restored empty' : 'no terminal tab in this window'));
}

/// STARTUP RULE, run once on the first scan: a light comes back only for a session
/// that still HAD a claude tab when this window last saved its bindings. Everything
/// else in the lookback window was closed - here or in another window - so it starts
/// in the "idle" dropdown, exactly as if its tab had just been closed, instead of the
/// row of lights for every session of the last few hours. Catching the close event
/// cannot be relied on for this (a window going away closes tabs without telling us,
/// and an unbound tab has no session to record), so what WAS open is the safer thing
/// to ask. Exempt: anything still being written, which is genuinely live somewhere.
/// Nothing is lost either way - idle sessions stay one click away in the dropdown,
/// and any new transcript activity promotes one straight back to a light.
function seedIdle() {
    const hadTabs = claude.savedTabSessions();
    let n = 0;
    for (const s of shared.sessions.values()) {
        if (hadTabs.has(s.id) || s.closedTab) continue;
        if (shared.quiet(s) < orphanMs()) continue;
        shared.suppressed.set(s.id, s.parsedMtime || s.lastWriteMs || Date.now());
        s.closedTab = true;
        n++;
    }
    shared.nlog('startup: ' + hadTabs.size + ' session(s) had a tab, ' + n + ' with none -> idle');
    if (n) shared.saveSuppressed();
}

/// The only commands a session hover is allowed to invoke. `isTrusted: true` would let
/// any command: link in the hover run anything VS Code can run - and the hover carries
/// text this extension did not write (see shared.mdText). Naming them keeps the links
/// working and makes the blast radius of an escaped one "a Chutdown light closes".
const HOVER_COMMANDS = ['chutdown.copySession', 'chutdown.dismissSession',
                        'chutdown.dismissOrphans', 'chutdown.showSession',
                        'chutdown.openTranscript', 'chutdown.renameSession',
                        'chutdown.setIdleMinutes', 'chutdown.setLookbackHours',
                        'chutdown.showHistory'];

// ------------------------------------------------- the two numbers behind this entry
//
// The "n idle" entry is entirely defined by two settings, and both are the sort you only
// think about while looking at it - "why has that folded away already", "where did
// yesterday's session go". So they are editable FROM it, as links in its hover, rather
// than by finding `chutdown.staleMinutes` in settings.json.
//
// A pick, not a text box: the useful values are a short list, and the current one is
// marked. Custom is still there for anyone who wants 45.
const IDLE_PRESETS = [
    { value: 10, detail: 'Aggressive - only what you are working on right now keeps a light' },
    { value: 30, detail: 'The default. Long enough to survive a coffee, short enough to stay tidy' },
    { value: 60, detail: 'Roomy - a light lasts most of a working session' },
    { value: 120, detail: 'Everything from the last couple of hours keeps its light' },
    { value: 480, detail: 'Effectively never fold anything away during a working day' }
];
const HISTORY_PRESETS = [
    { value: 6, detail: 'This morning, or this afternoon' },
    { value: 12, detail: 'Half a day' },
    { value: 24, detail: 'The default. Yesterday evening is still reachable' },
    { value: 48, detail: 'Two days - Monday is still there on Wednesday morning' },
    { value: 168, detail: 'A week. The scan reads more transcripts, so the poll costs more' }
];

/// Write a number setting into the scope it is ALREADY set in, so a workspace-level
/// value is not silently shadowed by a global write the user never sees take effect.
async function writeSetting(key, value) {
    const inspect = shared.cfg().inspect(key) || {};
    const target = inspect.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await shared.cfg().update(key, value, target);
}

async function pickNumber(key, title, unit, presets, max) {
    const current = Number(shared.cfg().get(key));
    const items = presets.map((p) => ({
        label: (p.value === current ? '$(check) ' : '$(blank) ') + p.value + ' ' + unit,
        detail: p.detail, value: p.value
    }));
    items.push({ label: '$(edit) Something else...', detail: 'Type a number', value: null });
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: 'Currently ' + current + ' ' + unit });
    if (!pick) return;                                  // escaped - leave it alone
    let value = pick.value;
    if (value === null) {
        const typed = await vscode.window.showInputBox({
            title, value: String(current), prompt: 'A number of ' + unit + ' (1 - ' + max + ')',
            validateInput: (v) => {
                const n = Number(v);
                return isFinite(n) && n >= 1 && n <= max ? undefined : 'A number between 1 and ' + max;
            }
        });
        if (typed === undefined) return;
        value = Number(typed);
    }
    await writeSetting(key, value);
}

function setIdleMinutes() {
    return pickNumber('staleMinutes', 'Chutdown: fold a session into "idle" after',
        'minutes', IDLE_PRESETS, 10_080);
}

function setLookbackHours() {
    return pickNumber('lookbackHours', 'Chutdown: how far back sessions are remembered',
        'hours', HISTORY_PRESETS, 720);
}

/// Nothing here is going to resume a dead session for you, so its light needs a way
/// OUT as well as in: these hover links close the one you are pointing at, or every
/// tab-less one at once (the usual case right after a reload).
/// The hover's way out for its TEXT: a hover cannot be selected, so every light
/// carries a link that puts its contents on the clipboard.
function copyLink(id) {
    const arg = encodeURIComponent(JSON.stringify([id]));
    return '[$(copy) Copy text](command:chutdown.copySession?' + arg + ')';
}

/// The name next to the light is the AI namer's guess, and its way out when the guess
/// is wrong is this link: an input box pre-filled with the current word.
function renameLink(id) {
    const arg = encodeURIComponent(JSON.stringify([id]));
    return '[$(edit) Edit name](command:chutdown.renameSession?' + arg +
        ' "Rename this session\'s light and tab")';
}

/// The idle hover's own way IN: a link per row that opens (or resumes) that session,
/// so a name can be clicked straight from the hover instead of going through the
/// dropdown. Bold, because it is the row's title as well as its link.
function showLink(s) {
    const arg = encodeURIComponent(JSON.stringify([s.id]));
    return '[**' + shared.mdText(s.name) + '**](command:chutdown.showSession?' + arg +
        ' "Open or resume this session")';
}

/// The raw .jsonl, opened as an editor tab. `chutdown.openTranscript` was registered
/// and declared but reachable from nowhere at all - no link, no menu, and `when: false`
/// hides it from the palette - while the README promised the transcript was one click
/// away. This is the click: a light still opens or resumes the SESSION, which is what
/// you want ninety-nine times in a hundred, and the hundredth is a link away.
function transcriptLink(s) {
    const arg = encodeURIComponent(JSON.stringify([s.file]));
    return '[$(go-to-file) Transcript](command:chutdown.openTranscript?' + arg +
        ' "Open the raw .jsonl this light is read from")';
}

function closeLinks(id) {
    const arg = encodeURIComponent(JSON.stringify([id]));
    return '[$(close) Close](command:chutdown.dismissSession?' + arg + ')' +
        ' · [$(clear-all) Close all with no tab](command:chutdown.dismissOrphans)';
}

/// VS Code gives extensions NO way to make a hover selectable - the widget dies the
/// moment the pointer leaves it, so the assistant's last answer sitting in there was
/// unreachable. This copies what the hover shows - name, state, quiet time, the first
/// and latest prompt, and the latest output (the same 800-char tail scan.js keeps) - as
/// plain text, plus the cwd and session id the hover has no room for.
async function copySession(id) {
    const s = shared.sessions.get(id);
    if (!s) return;
    const { e, label } = resolve(s);
    const text = [
        e + ' ' + s.name + ' - ' + label + ' - quiet ' + shared.humanize(shared.quiet(s)),
        s.cwd ? 'cwd: ' + s.cwd : '',
        'session: ' + s.id,
        s.prompt ? '\nfirst asked:\n' + s.prompt : '',
        s.lastPrompt && s.lastPrompt !== s.prompt ? '\nlast asked:\n' + s.lastPrompt : '',
        s.lastText ? '\nlatest output:\n' + s.lastText : ''
    ].filter(Boolean).join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('Copied "' + s.name + '" (' + text.length + ' chars).', 3000);
}

/// A rename the USER typed goes through exactly the AI namer's apply path - uniqueName
/// so two tabs never share a word, the name cache so it survives a reload, aiNamed so
/// the namer never second-guesses a human, and renameActiveClaude for the tab title
/// (which, as ever, can only land on the tab once it is the active one).
async function renameSession(id) {
    const s = shared.sessions.get(id);
    if (!s) return;
    const typed = await vscode.window.showInputBox({
        prompt: 'New name for "' + s.name + '"',
        value: s.name,
        validateInput: (v) => {
            const t = String(v || '').trim();
            if (!t) return 'A name is needed';
            if (t.length > 14) return 'Max 14 characters - it has to fit a tab title';
            return null;
        }
    });
    if (typed === undefined) return;            // Esc
    const word = String(typed).trim();
    if (!word || word === s.name) return;
    const unique = shared.uniqueName(id, word);
    shared.nlog('rename: "' + s.name + '" -> "' + unique + '" (user)');
    s.name = unique;
    s.aiNamed = true;                           // a human's word outranks the namer's
    naming.cacheName(id, unique);
    renderSessions();
    claude.renameActiveClaude();
}

/// "Close": the session leaves the lights for the "idle" dropdown, exactly as closing
/// its claude tab does - and the dismissal now STICKS across reloads. Nothing is
/// deleted: the transcript is untouched and picking it out of the dropdown resumes it.
function dismissSession(id) {
    const s = shared.sessions.get(id);
    shared.suppressed.set(id, s ? s.parsedMtime : Date.now());
    if (s) s.closedTab = true;
    shared.saveSuppressed();
    renderSessions();
}

/// "No tab here" - ONE definition, used both to count the orphans the dropdown offers
/// to close and to decide which ones actually close. They used to be two: the count
/// took anything resolve() drew as not-local (which includes a session another window
/// is writing right now, and a tab revived empty after a quit), while the close skipped
/// exactly those two cases. So the entry offered to close N sessions and then closed
/// none of them, or closed fewer than it said - the count lying about its own button.
/// A tab restored empty by a quit counts as no tab: nothing is running in it.
function isOrphan(s) {
    if (s.closedTab) return false;
    if (claude.hasLocalTerminal(s.id) && !claude.revivedTab(s.id)) return false;
    return shared.quiet(s) >= orphanMs();
}

/// Clear the whole post-reload row in one go: every session with no terminal tab in
/// this window (live ones running elsewhere are left alone).
function dismissOrphans() {
    let n = 0;
    for (const s of shared.sessions.values()) {
        if (!isOrphan(s)) continue;
        shared.suppressed.set(s.id, s.parsedMtime || Date.now());
        s.closedTab = true;
        n++;
    }
    if (!n) { vscode.window.showInformationMessage('No tab-less sessions to close.'); return; }
    shared.saveSuppressed();
    renderSessions();
    vscode.window.setStatusBarMessage('Closed ' + n + ' session light(s) - still listed under "idle".', 4000);
}

/// Not italic, and a notch larger than the rest of the hover: these two lines are what
/// anyone reads a light's hover FOR, and body-size italics buried them under the bold
/// status line above. The <span> needs `supportHtml` on the hover - without it the line
/// still reads, just at the old size.
function promptLine(label, text) {
    return (label ? '**' + label + '** ' : '') +
           '<span style="font-size:1.15em">' + shared.mdText(text) + '</span>  \n';
}

/// The footer's two lines: what this session was STARTED on, and what it was last asked
/// to do. Together they say what a tab is for far better than either alone - the first
/// prompt is the session's identity (it is where its name came from), the latest one is
/// what it is actually doing right now, and after a few hours those are rarely the same
/// thing. They collapse back to one unlabelled line while a session is still on its
/// first prompt, which is most of its early life, and while scan.js has not managed to
/// read a newer one (a prompt further back than the tail window it reads).
/// Both are the user's own text - escaped, never pasted into markdown the hover trusts.
function promptLines(s) {
    const first = String(s.prompt || '').trim();
    const last = String(s.lastPrompt || '').trim();
    if (!first) return last ? promptLine('', last) : '';
    if (!last || last === first) return promptLine('', first);
    return promptLine('First', first) + promptLine('Latest', last);
}

/// One status bar entry PER SESSION: emoji + name, hover shows the latest assistant
/// output, click reveals that session's terminal in the editor area. Only LIVE
/// sessions earn a light down here - 🟢 processing and 🟠 asking for input; a live one
/// with NO terminal tab in this window shows ⚪ instead (click offers to resume it
/// here). Finished and unknown ones stay reachable through the Sessions & Terminals
/// dropdown, and anything quiet longer than staleMinutes folds into the single "idle"
/// dropdown entry regardless of color.
function renderSessions() {
    for (const [id, item] of sessionItems)
        if (!shared.sessions.has(id)) { item.dispose(); sessionItems.delete(id); releasePrio(id); }

    const stale = [];
    const list = [...shared.sessions.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    for (const s of list) {
        let item = sessionItems.get(s.id);
        const light = lightFor(s).e;
        // A closed session that got resumed here has a tab again - promote it back.
        // (a tab VS Code restored EMPTY after a quit is not the user reopening it)
        if (s.closedTab && claude.hasLocalTerminal(s.id) && !claude.revivedTab(s.id)) {
            s.closedTab = false;
            if (shared.suppressed.delete(s.id)) shared.saveSuppressed();
        }
        // Closed-tab sessions go straight to the idle dropdown, however young.
        // NEVER THIS WINDOW'S - no light, at any point in its life. Another window's
        // session is that window's business: you cannot see its tab from here, clicking
        // it here can only offer to resume it somewhere it is already running, and on a
        // fresh VS Code it arrives as a stray entry for work you did not start.
        //
        // seedIdle applies "only what was open here comes back" ONCE, at the first scan,
        // and used to exempt anything written in the last orphanMinutes as live
        // elsewhere. Nothing re-checked that, so such a session kept a light here for the
        // rest of the hour - ⚪ while the other window was still writing it, then
        // 🔴 "no terminal tab in this window" once that window was done. Now the test is
        // simply "was this session ever opened HERE", applied on every render. It is not
        // persisted, so a session that later opens in this window gets its light at once.
        //
        // IDLE, UNLESS IT IS OPEN HERE. A session sitting quiet past staleMinutes folds
        // into the one "n idle" entry - but a tab in this window that is actually running
        // it keeps its light however long it sits, because that light is about a tab you
        // have open in front of you, not about how recently it wrote anything.
        //
        // Both rules live in isIdle now, and this is the only place they are applied.
        // They used to be written out here as two separate `continue`s while isIdle - the
        // predicate the "n idle" entry's own CLICK filters by - tested only the second
        // one. The count and the list it opened were therefore answering different
        // questions: a session running right now in another window (quiet ~0, never bound
        // here, tab not closed) was counted but not listed, so clicking "3 idle" opened a
        // list of two, and a session that was merely quiet with a live tab here was
        // listed while keeping its own light.
        if (isIdle(s)) {
            stale.push(s);
            if (item) shared.unpaint(item);
            continue;
        }
        if (light === '⚪') { if (item) shared.unpaint(item); continue; }   // unknown -> dropdown only
        if (!item) {
            item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, nextSessionPrio(s.id));
            item.command = { command: 'chutdown.showSession', arguments: [s.id], title: 'Show' };
            sessionItems.set(s.id, item);
        }
        const { e, label, local } = resolve(s);
        const md = new vscode.MarkdownString();
        md.isTrusted = { enabledCommands: HOVER_COMMANDS };   // the Close/Copy links below
        md.supportThemeIcons = true;    // ...and their $(codicon) labels
        md.supportHtml = true;          // ...and the prompt lines' <span> sizing
        // `coarse`, not `humanize`: a quiet time counted in seconds changes on every 5s
        // poll, and a hover whose text changes is a hover VS Code closes - so the one
        // number nobody needs to the second was enough to make every light's hover
        // twitch shut while it was being read (shared.js).
        md.appendMarkdown(e + ' **' + label + '** - quiet ' + shared.coarse(shared.quiet(s)) + '  \n');
        // The prompts and the answer are the user's and Claude's text, not ours - escaped
        // rather than pasted into markdown that the hover trusts (shared.js).
        if (s.lastText) md.appendMarkdown('\n' + shared.mdCode(s.lastText, 'text'));
        md.appendMarkdown('\n' + promptLines(s));
        md.appendMarkdown(local ? '\n_Click to show in the editor area_  \n'
            : '\n_Click to resume it in a terminal here_  \n');
        md.appendMarkdown(copyLink(s.id) + ' · ' + renameLink(s.id) + ' · ' + transcriptLink(s) +
            (local ? '' : ' · ' + closeLinks(s.id)));
        shared.paint(item, { text: e + ' ' + s.name, tooltip: md });
    }

    renderStale(stale);
}

/// Sessions quiet for over staleMinutes - plus any whose tab was CLOSED, however
/// young - live in ONE dropdown entry instead of individual lights; click the item
/// for the full list, or click a NAME right in the hover to jump to that session
/// (which resumes it, since a closed one has no tab).
function renderStale(stale) {
    const staleItem = shared.items.stale;
    if (stale.length === 0) { shared.unpaint(staleItem); return; }
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };   // the per-session links below
    md.supportThemeIcons = true;
    // A DAY of work is dozens of idle sessions, and every one of them used to get a line
    // here - a hover taller than the screen, which you scroll rather than read, and which
    // covers the editor while you do it. The newest handful is what anyone is actually
    // looking for; the rest are one click away in the list, where they are grouped by age
    // and can be filtered by typing.
    // Newest first, which renderSessions' order is NOT - it walks sessions oldest-first,
    // so slicing that would have shown the eight LEAST likely to be wanted.
    const recent = stale.slice().sort((a, b) => b.lastWriteMs - a.lastWriteMs);
    const HOVER_MAX = 8;
    for (const s of recent.slice(0, HOVER_MAX)) {
        const { e, label } = resolve(s);
        md.appendMarkdown(e + ' ' + showLink(s) + ' - ' +
            (s.closedTab ? 'tab closed' : label) +
            ', quiet ' + shared.coarse(shared.quiet(s)) + '  \n');
    }
    if (recent.length > HOVER_MAX)
        md.appendMarkdown('\n_...and ' + (recent.length - HOVER_MAX) + ' older - click for the full list_  \n');
    md.appendMarkdown('\n_Click a name to open or resume it - or the item for the whole list_  \n');
    // The two numbers that decide what is in this list, and what it can ever contain -
    // stated, and editable from here, because this entry is where you notice them.
    const mins = Math.max(1, Number(shared.cfg().get('staleMinutes')) || 30);
    const hours = Math.max(1, Number(shared.cfg().get('lookbackHours')) || 24);
    md.appendMarkdown('\nFolded here after **' + mins + ' min** quiet, unless open in a tab here.' +
        ' Remembered for **' + hours + 'h**.  \n');
    md.appendMarkdown('\n[$(history) Full history](command:chutdown.showHistory)' +
        ' · [$(clock) Idle after...](command:chutdown.setIdleMinutes)' +
        ' · [$(watch) Remember for...](command:chutdown.setLookbackHours)');
    shared.paint(staleItem, { text: '$(history) ' + stale.length + ' idle', tooltip: md });
}

/// Session lights are created on demand, so they are not in context.subscriptions like
/// every other item - and only ever disposed one at a time, when a session ages out of
/// the scan. On teardown (disable, uninstall, reload) VS Code disposes the
/// subscriptions and unregisters the commands, and these were left behind: entries
/// still sitting in the status bar whose click now errors with "command not found".
function disposeSessionItems() {
    for (const it of sessionItems.values()) it.dispose();
    sessionItems.clear();
    itemPrios.clear();
    takenPrios.clear();
}

/// THE one test for "this session folds into the idle dropdown instead of wearing a
/// light of its own". renderSessions applies it to build the list, showStale applies it
/// to fill the quick pick, and the dropdown applies it to decide what to show - so all
/// three now agree by construction rather than by three authors agreeing.
///
/// Three ways in, and they are not the same rule:
///   - never opened HERE: another window's session, which cannot have a light in this
///     one at any age (see renderSessions for why),
///   - tab closed: however young,
///   - quiet past staleMinutes AND not running in a tab here.
function isIdle(s) {
    if (!runningHere(s) && !claude.everBoundHere(s.id)) return true;
    if (s.closedTab) return true;
    if (runningHere(s)) return false;
    return shared.quiet(s) >= Math.max(1, Number(shared.cfg().get('staleMinutes')) || 30) * 60_000;
}

/// Which age band an idle session falls in. A day of work puts dozens of sessions in this
/// list, and a flat list of forty is a list you scroll rather than read - the one from
/// twenty minutes ago and the one from yesterday morning look identical in it. Grouping by
/// WHEN is what makes it scannable: the answer to "where did that session go" is almost
/// always "some time this afternoon", and that narrows forty rows to five.
const AGE_BANDS = [
    { max: 3_600_000, title: 'Last hour' },
    { max: 4 * 3_600_000, title: 'Last few hours' },
    { max: 12 * 3_600_000, title: 'Earlier today' },
    { max: Infinity, title: 'Older' }
];

function ageBand(s) {
    const age = shared.quiet(s);
    return AGE_BANDS.find((b) => age < b.max).title;
}

async function showStale() {
    const list = [...shared.sessions.values()].filter(isIdle)
        .sort((a, b) => b.lastWriteMs - a.lastWriteMs);
    // Say something. A bare return left the click looking broken - the entry simply
    // vanished at the next 5 s repaint with no explanation - and back when this filter
    // disagreed with the one that built the count, it was reachable with the entry still
    // reading "2 idle". It should not be reachable now (both sides ask isIdle), so if it
    // ever is, the message is the bug report.
    if (list.length === 0) {
        shared.unpaint(shared.items.stale);
        vscode.window.showInformationMessage('Chutdown: no idle sessions - they are all live, or all gone.');
        return;
    }
    const picks = [];
    let band = null;
    for (const s of list) {
        const here = ageBand(s);
        if (here !== band) { band = here; picks.push({ label: band, kind: vscode.QuickPickItemKind.Separator }); }
        const { e, label } = resolve(s);
        picks.push({
            label: e + ' ' + s.name,
            description: (s.prompt || '').slice(0, 60),
            detail: (s.closedTab ? 'tab closed - pick to resume' : label) +
                ' - quiet ' + shared.coarse(shared.quiet(s)) + '  ·  ' + s.cwd,
            id: s.id
        });
    }
    // The way OUT of a list this long. Everything here is already idle - nothing is
    // running, nothing is lost - so forgetting the lot is a safe thing to offer, and it
    // is the only thing that actually shortens the list rather than paging through it.
    // (They come back on their own the moment one is resumed.)
    picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    picks.push({
        label: '$(clear-all) Forget all ' + list.length + ' idle session(s)',
        detail: 'Clears this list. Nothing is deleted - a transcript is still on disk, and ' +
            'any of them reappears the moment it is resumed or written to again',
        forgetAll: true
    });

    const pick = await vscode.window.showQuickPick(picks, {
        title: 'Idle sessions - ' + list.length + ' quiet over ' +
            (Number(shared.cfg().get('staleMinutes')) || 30) + ' min, or with their tab closed',
        placeHolder: 'Type to filter by name, prompt or folder',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!pick) return;
    if (pick.forgetAll) {
        for (const s of list) {
            shared.suppressed.set(s.id, s.parsedMtime || s.lastWriteMs || Date.now());
            s.closedTab = true;
        }
        shared.saveSuppressed();
        renderSessions();
        vscode.window.setStatusBarMessage('Forgot ' + list.length + ' idle session(s).', 4000);
        return;
    }
    claude.showSession(pick.id);
}

// ------------------------------------------------- the history list
//
// WHEN something last happened, as a clock time rather than an age. The idle list
// answers "how long ago" (quiet 40 min); the history answers "which one was that" -
// and what anyone remembers about a session is that it was the one just before lunch.
// Today is bare (14:32), yesterday is named, anything older carries its date.
function whenText(ms) {
    if (!ms) return 'never';
    const then = new Date(ms);
    const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    if (ms >= midnight.getTime()) return time;
    if (ms >= midnight.getTime() - 86_400_000) return 'Yesterday ' + time;
    return then.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) +
        ' ' + time;
}

/// The whole history: every session still inside the lookback window - live ones and
/// idle ones - newest first and grouped by age, with when it last ran in its own column.
/// The idle entry's "History" link used to open the lookback SETTING, a number of hours,
/// which is the one thing about the history that is not the history. The setting is still
/// a click away - from its own link in the hover, and from the last row here, which
/// re-opens this list on the new window rather than dropping you back to the status bar.
async function showHistory() {
    const hours = Math.max(1, Number(shared.cfg().get('lookbackHours')) || 24);
    const list = [...shared.sessions.values()].sort((a, b) => b.lastWriteMs - a.lastWriteMs);
    const picks = [];
    let band = null;
    for (const s of list) {
        const here = ageBand(s);
        if (here !== band) { band = here; picks.push({ label: band, kind: vscode.QuickPickItemKind.Separator }); }
        const { e, label, local } = resolve(s);
        const idle = isIdle(s);
        picks.push({
            label: e + ' ' + s.name,
            // The time gets a column of its own, ahead of the state and the folder, so a
            // day of sessions reads down the list as a timeline.
            description: whenText(s.lastWriteMs) + '  ·  ' + shared.coarse(shared.quiet(s)) + ' ago',
            detail: (s.closedTab ? 'tab closed - pick to resume' : label) +
                (idle ? '' : '  ·  still live') + (local ? '' : '  ·  no tab here') +
                (s.prompt ? '  ·  ' + shared.flat(s.prompt, 60) : '') + '  ·  ' + s.cwd,
            id: s.id
        });
    }
    if (list.length === 0) picks.push({ label: 'No sessions in the last ' + hours + 'h', empty: true });
    picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    picks.push({
        label: '$(watch) Remembered for ' + hours + 'h - change...',
        detail: 'How far back sessions are scanned at all. Anything older is not in this list',
        setHours: true
    });
    const pick = await vscode.window.showQuickPick(picks, {
        title: 'Session history - ' + list.length + ' session(s) from the last ' + hours + 'h',
        placeHolder: 'Type to filter by name, time, prompt or folder',
        matchOnDescription: true,
        matchOnDetail: true
    });
    if (!pick || pick.empty) return;
    if (pick.setHours) { await setLookbackHours(); return showHistory(); }
    claude.showSession(pick.id);
}

/// The dropdown: every Claude session and every batch terminal; picking one jumps
/// to its tab (or opens the transcript when there is no tab for it).
async function showTabs() {
    const picks = [];
    const list = [...shared.sessions.values()].sort((a, b) => b.lastWriteMs - a.lastWriteMs);
    if (list.length) picks.push({ label: 'Claude sessions', kind: vscode.QuickPickItemKind.Separator });
    let orphans = 0;
    for (const s of list) {
        const { e, label, local } = resolve(s);
        if (isOrphan(s)) orphans++;
        picks.push({
            label: e + ' ' + s.name,
            description: (s.prompt || '').slice(0, 60),
            detail: label + ' - quiet ' + shared.humanize(shared.quiet(s)) +
                (local ? '' : '  ·  no tab here') + '  ·  ' + s.cwd,
            session: s
        });
    }
    if (orphans) picks.push({
        label: '$(clear-all) Close all ' + orphans + ' session(s) with no tab here',
        detail: 'They move to the "idle" dropdown and stay closed across reloads',
        dismissAll: true
    });
    if (shared.termRecs.size) picks.push({ label: 'Batch terminals', kind: vscode.QuickPickItemKind.Separator });
    for (const [name, rec] of shared.termRecs)
        picks.push({
            label: batch.termLight(rec) + ' ' + name,
            description: rec.command,
            detail: rec.exited ? '(closed - pick to dismiss)'
                : batch.termState(rec) + '  ·  ' + (rec.lines[rec.lines.length - 1] || ''),
            termName: name
        });
    if (picks.length === 0) {
        vscode.window.showInformationMessage('No Claude sessions or batch terminals right now.');
        return;
    }
    const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Claude sessions and batch terminals',
        matchOnDescription: true
    });
    if (!pick) return;
    if (pick.dismissAll) { dismissOrphans(); return; }
    if (pick.termName !== undefined) {
        const rec = shared.termRecs.get(pick.termName);
        if (!rec) return;
        if (rec.exited) { rec.item.dispose(); shared.termRecs.delete(pick.termName); renderSessions(); }
        else rec.terminal.show();
        return;
    }
    if (pick.session) claude.showSession(pick.session.id);
}

Object.assign(module.exports, {
    lightFor, couldStillBeRunning, isIdle, renderSessions, showStale, showTabs, showHistory,
    dismissSession, dismissOrphans, copySession, renameSession, seedIdle, disposeSessionItems,
    setIdleMinutes, setLookbackHours, ageBand
});

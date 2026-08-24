// Claude terminals - the launch buttons, tab tracking/renaming, terminal<->session
// binding, and click-to-reveal/resume. Terminals opened through the extension are
// ours to rename; user-opened `claude` terminals get adopted via shell integration.

const vscode = require('vscode');

const shared = require('./shared');
const lights = require('./lights');
const identify = require('./identify');
const usage = require('./usage');
const density = require('./density');

function trackClaude(terminal, cwd, inEditor, hint) {
    const rec = { terminal, cwd, created: Date.now(), sessionId: '', lastTitle: '',
        inEditor: !!inEditor, pid: 0,
        resumeId: (hint && hint.resumeId) || '',        // `claude --resume <id>` seen on the command line
        continueFlag: !!(hint && hint.continueFlag),    // `claude --continue` / -c
        // The letter the tab's mark was created with ('' = the Chutdown "C"); undefined
        // when nobody knows what the tab wears (an adopted terminal). See refreshTabMarks.
        letter: hint && typeof hint.letter === 'string' ? hint.letter : undefined };
    shared.claudeRecs.push(rec);
    shared.nlog('tracking claude tab in ' + cwd + (rec.resumeId ? ' (--resume ' + rec.resumeId.slice(0, 8) + ')'
        : rec.continueFlag ? ' (--continue)' : ''));
    terminal.processId.then((pid) => { rec.pid = pid || 0; saveBindings(); }, () => { });
}

// ------------------------------------------- binding persistence (reloads)
//
// claudeRecs live in memory, but a window RELOAD keeps the terminals' shell
// processes alive and reconnects them - so the terminal<->session bindings are
// persisted keyed by processId and re-attached at activation. Without this every
// claude tab forgets its session (and its name) after a reload.
//
// QUITTING VS CODE (or rebooting the machine) is the harder case: the pty host dies
// with the app, so every saved pid is stale AND the tab comes back nameless - the
// rename we applied lives in the editor's saved state but is dropped when the process
// cannot be re-attached, leaving the creation name ("claude") or, once the relaunched
// shell writes its own title over the top, the bare shell name ("bash"). Neither is a
// key back to a session, so the bindings are ALSO saved as an ordered list with a slot
// for EVERY tab: reviveClaudeTabs() lines those slots up with the restored tabs at
// startup and puts the names back by position.

const BIND_KEY = 'claudeTermBindings';
const ORDER_KEY = 'claudeTermOrder';
// How long a pid match can still be a reload-survivor: until the restored tabs have
// settled, and never past RESTORE_MAX_MS. It used to be a flat 10s from activation,
// which was fine while the extension only woke after startup had finished - in the
// first activation wave the tabs can still be arriving well after that.
const TAB_SETTLE_MS = 1500;         // no new tab for this long = the restore is done
const TAB_GIVEUP_MS = 6_000;        // ...or this long, if fewer came back than we saved
const RESTORE_MAX_MS = 60_000;      // ...and we never wait past this whatever happens
let pendingDeadline = 0;
let pendingRestore = {};      // the pid map as saved BEFORE this window loaded
let pendingOrder = [];        // the same bindings in tab order, for the restart case
let hadTabs = new Set();      // sessions that still had a tab when state was last saved
let restoredByPid = 0;        // how many tabs re-attached by pid (0 = the app restarted)
let savedPidCount = 0;
let lastSavedBindings = '';
// Set by reviveClaudeTabs when the saved sessions found NO restored tab to pair with:
// the tabs the window came back with, and how many sessions were saved. While those
// very tabs are still the whole window, saveBindings leaves the stored list alone.
let keepSaved = null;
// Sessions still waiting for their tab after the settle pass (reviveClaudeTabs holds
// them in pendingOrder): the rest of the tabs can still arrive, and each one that does
// re-runs the pairing (restoreBinding) - until lateDeadline, RESTORE_MAX_MS from load.
let lateDeadline = 0;
let lateTimer = null;
let savedSlotCount = 0;       // tabs the saved list had a slot for = how many to expect back
let firstPassDone = false;    // the settle pass has run; later tabs are "late"
let triedTouched = new Set(); // restored tabs a pass offered a session and found in use

function saveBindings() {
    if (!shared.state.extContext) return;
    // Nothing bound, and the list we loaded had sessions that never found their tab: a
    // save now would replace the only record of those sessions with a row of
    // placeholders - and that is what turned ONE missed pairing into a window that came
    // back "empty of everything" on the next reload, and the one after. The saved
    // list is held, untouched, for as long as the window is exactly the tabs it was
    // restored with; a tab opened or closed, or a session bound, and saving is live
    // again - the user has moved on, and the list should follow what is actually open.
    if (keepSaved) {
        const t = vscode.window.terminals;
        const same = t.length === keepSaved.terms.size && t.every((x) => keepSaved.terms.has(x));
        const bound = shared.claudeRecs.some((r) => r.sessionId && t.includes(r.terminal));
        // ...or sessions are still waiting for tabs that may yet arrive (holdRest).
        const waiting = pendingOrder.length > 0 && Date.now() < lateDeadline;
        if (waiting || (same && !bound)) {
            if (!keepSaved.said) {
                keepSaved.said = true;
                shared.nlog('bindings: keeping the saved list - ' + keepSaved.n +
                    ' session(s) in it never found their restored tab');
            }
            return;
        }
        keepSaved = null;
    }
    const map = {};
    for (const r of shared.claudeRecs)
        if (r.pid && r.sessionId && vscode.window.terminals.includes(r.terminal))
            map[String(r.pid)] = { sessionId: r.sessionId, cwd: r.cwd,
                                   created: r.created, inEditor: r.inEditor,
                                   // The letter the tab's GLYPH mark wears ('' = the C) - a
                                   // glyph survives the reload, so the restored rec can
                                   // trust it. Named for what it is: a binding written
                                   // while the marks were still SVGs has no `glyph`, and
                                   // that tab comes back bare (restoreBinding).
                                   glyph: r.letter };
    // Same records, in tab order, each carrying the title last written to its tab -
    // the only key that survives a full quit (pids do not). EVERY tab takes a slot,
    // claude or not: a restored tab is retitled by its own shell before we ever see it,
    // so its POSITION in this list is the only thing left that still identifies it.
    const order = [];
    for (const t of vscode.window.terminals) {
        const r = shared.claudeRecs.find((x) => x.terminal === t);
        order.push(r && r.sessionId
            ? { sessionId: r.sessionId, cwd: r.cwd, created: r.created,
                inEditor: r.inEditor, title: r.lastTitle || '' }
            : { sessionId: '', name: t.name || '' });   // a placeholder, holding the slot
    }
    const json = JSON.stringify(map) + JSON.stringify(order);
    if (json === lastSavedBindings) return;
    lastSavedBindings = json;
    shared.state.extContext.workspaceState.update(BIND_KEY, map);
    shared.state.extContext.workspaceState.update(ORDER_KEY, order);
}

/// A terminal that survived a reload: its shell pid is the key back to the session
/// it was bound to. Reads the map captured at activation, NOT live state - the
/// periodic saveBindings() overwrites the store before slow pids resolve.
function restoreBinding(terminal) {
    // A tab arriving AFTER the settle pass while sessions are still waiting for theirs
    // (holdRest): run the pairing again once this burst of tabs has settled.
    if (firstPassDone && pendingOrder.length && Date.now() < lateDeadline) {
        if (lateTimer) clearTimeout(lateTimer);
        lateTimer = setTimeout(() => {
            lateTimer = null;
            try { reviveClaudeTabs(); } catch (e) { shared.nlog('revive: ' + e.message); }
        }, TAB_SETTLE_MS);
        if (lateTimer.unref) lateTimer.unref();
    }
    terminal.processId.then((pid) => {
        if (!pid) return;
        // Only terminals that were ALREADY THERE when this window loaded can be
        // reload-survivors. extension.js calls this for every terminal opened for the
        // life of the window, and after a full quit every saved pid is stale - so a
        // batch terminal opened an hour later whose shell happened to get a recycled
        // pid was adopted into that session: its tab renamed to the session's name,
        // and the session's light pointed at a dev server. The window closes a few
        // seconds after activation, at the same moment reviveClaudeTabs() gives up.
        if (Date.now() > pendingDeadline) return;
        const b = pendingRestore[String(pid)];
        if (!b) return;
        delete pendingRestore[String(pid)];
        restoredByPid++;
        // Every saved pid claimed: the reload-survivors are all back, so the adoption
        // window shuts NOW. It used to stay open toward RESTORE_MAX_MS - a minute, up
        // from the old flat 10s - and whenTabsSettle cannot close it early, because its
        // quiet timer restarts on every change in terminals.length, including the tabs
        // a `.terminals` batch is opening. That is the recycled-pid window above, held
        // open for the whole of exactly the moment new tabs are being created.
        if (!Object.keys(pendingRestore).length) pendingDeadline = 0;
        if (shared.claudeRecs.some((r) => r.terminal === terminal || r.sessionId === b.sessionId)) return;
        shared.claudeRecs.push({ terminal, cwd: b.cwd, created: b.created, sessionId: b.sessionId,
            lastTitle: '', inEditor: b.inEditor, pid, resumeId: '', continueFlag: false,
            // The letter its glyph mark wears (saveBindings) - a ThemeIcon comes back
            // from a reload as it was. A binding written while the marks were still
            // SVGs has no `glyph`, and that tab really IS bare now: a file-URI icon does
            // not survive a reload (seen 2026-08-22: four lettered tabs, four "≡" after
            // the reload), so it is recorded as wearing nothing until refreshTabMarks
            // reopens it - once, wearing the glyph.
            letter: typeof b.glyph === 'string' ? b.glyph : undefined });
        renameActiveClaude();
    }, () => { });
}

/// Terminals restored by the window reload may already exist before the
/// onDidOpenTerminal listener was registered - capture the saved map and re-bind
/// those now (called once from activate). Whatever is still unclaimed once the tabs
/// have settled is the after-a-full-quit case, handled by order instead.
function loadPendingBindings() {
    const store = shared.state.extContext.workspaceState;
    pendingDeadline = Date.now() + RESTORE_MAX_MS;
    lateDeadline = Date.now() + RESTORE_MAX_MS;
    marksDue = Date.now() + RESTORE_MAX_MS;    // the marks pass keeps trying this long (pollTabMarks)
    marksSaid = '';
    marksWhy = 'window loaded';
    restoredByPid = 0;
    keepSaved = null;
    firstPassDone = false;
    triedTouched = new Set();
    if (lateTimer) { clearTimeout(lateTimer); lateTimer = null; }
    pendingRestore = Object.assign({}, store.get(BIND_KEY) || {});
    pendingOrder = (store.get(ORDER_KEY) || []).slice();
    savedPidCount = Object.keys(pendingRestore).length;
    savedSlotCount = pendingOrder.length;
    // The record of which sessions still HAD a tab when this window last saved - the
    // one thing we know at startup about what was open and what had been closed.
    // reviveClaudeTabs() empties pendingOrder, so it is captured here, not read later.
    hadTabs = new Set();
    for (const k of Object.keys(pendingRestore)) hadTabs.add(pendingRestore[k].sessionId);
    for (const e of pendingOrder) if (e && e.sessionId) hadTabs.add(e.sessionId);
    for (const t of vscode.window.terminals) restoreBinding(t);
    whenTabsSettle(() => {
        try { reviveClaudeTabs(); } catch (e) { shared.nlog('revive: ' + e.message); }
        pendingRestore = {};        // nothing left here can be a reload-survivor
        pendingDeadline = 0;        // ...and no later tab can be adopted by a stale pid
        // Whatever is STILL unbound gets the exact answer: which session each tab is
        // actually running, read from claude's own pid files (src/identify.js). That is
        // the only thing that can put a status back on a tab whose claude was already
        // running when this window loaded - and it is done here, at startup, rather
        // than waiting for the poll's gap to come round.
        // ...and once everything that CAN be bound is bound, one flick through the tabs
        // puts the names on all of them. Without it only the tab the window restored in
        // front wore its session's word; the rest stayed nameless until they were
        // clicked, because a rename can only ever land on the active tab.
        const swept = () => {
            shared.clearGate('tabs');
            // ...and the MARKS first: a tab whose icon no longer says what its session is
            // running is reopened wearing the right letter (born titled, so it needs no
            // flick), before the flick stamps the tabs that stay.
            try { refreshTabMarks('window loaded'); } catch (e) { shared.nlog('marks: ' + e.message); }
            if (shared.cfg().get('restoreTabNames'))
                sweepTabTitles('window loaded').catch((e) => shared.nlog('rename: sweep - ' + e.message));
        };
        identify.sweepNow().then(swept, swept);
    });
}

/// Activating in the first wave means the extension can be up before VS Code has
/// restored a single terminal, so the pass that puts the names back cannot run on a
/// fixed timer: it waits for the tab set to stop growing (every saved slot accounted
/// for, then a quiet moment), and gives up at RESTORE_MAX_MS however few came back.
/// A window with nothing saved does not wait at all.
function whenTabsSettle(run) {
    // Nothing saved, nothing to wait for - the settle loop would still hold the startup
    // spinner TAB_SETTLE_MS for a fresh workspace with no bindings and no order.
    if (!pendingOrder.length && !savedPidCount) return void setTimeout(run, 0);
    const started = Date.now();
    let seen = -1, changed = Date.now();
    const timer = setInterval(() => {
        const n = vscode.window.terminals.length;
        if (n !== seen) { seen = n; changed = Date.now(); }
        // Fewer tabs than slots is normal - tabs get closed, and a window can be
        // reopened with persistent sessions off - so a set that has simply gone quiet
        // is taken as final too, rather than holding the spinner for the full minute.
        const enough = n >= pendingOrder.length;
        const quiet = Date.now() - changed;
        if (!((enough && quiet >= TAB_SETTLE_MS) || quiet >= TAB_GIVEUP_MS ||
              Date.now() - started > RESTORE_MAX_MS)) return;
        clearInterval(timer);
        shared.nlog('restore: ' + n + ' tab(s) back after ' +
            Math.round((Date.now() - started) / 100) / 10 + 's' +
            (enough ? '' : ' (' + pendingOrder.length + ' expected - gave up waiting)'));
        run();
    }, 250);
    if (timer.unref) timer.unref();
}

/// The bare shell name a restored tab ends up wearing. VS Code brings the tab back
/// under the title it had, then the shell it relaunches writes its own title over the
/// top - with Git Bash as the default profile every restored claude tab reads "bash",
/// matching neither the creation name nor the title we saved, which is what left a
/// whole window of tabs nameless and unbound after a restart. tmux is in VS Code's own
/// default terminal.integrated.profiles.osx set and has no Windows counterpart, which is
/// why it was never noticed here - and it is the entry this list has to carry on its
/// own. The pid-file sweep that rescues an unrecognised restored tab (src/identify.js)
/// reads the process table on macOS too now, so a name missing from this list usually
/// still gets a second chance at being bound; under a multiplexer it does not, because
/// the tab's pid is the tmux CLIENT while claude runs under the tmux SERVER and the
/// ancestry the sweep walks never joins the two.
const SHELL_NAME = /^(?:bash|git ?bash|sh|zsh|fish|ksh|csh|tcsh|nu|pwsh|powershell|windows ?powershell|cmd|command prompt|wsl|ubuntu|debian|tmux|screen)$/i;

/// A tab VS Code brought back for us: still unbound, and wearing either the creation
/// name ("claude"), a title we wrote before the quit, or - after a full restart, where
/// nothing is running anywhere - the name of the shell that overwrote it. Batch
/// .terminals tabs carry their own names, so they never match.
function looksLikeClaudeTab(t, titles, dead) {
    if (shared.claudeRecs.some((r) => r.terminal === t)) return false;
    for (const r of shared.termRecs.values()) if (r.terminal === t) return false;
    return t.name === 'claude' || titles.has(t.name) ||
        (dead && SHELL_NAME.test((t.name || '').trim()));
}

/// The tabs are back but nameless: pair the saved bindings with them left to right
/// (the order VS Code restores tabs in is the order they were saved in) and put the
/// names back. Sessions still in the scan get their CURRENT light + name; ones that
/// aged out of the lookback window get the exact title they had at quit time.
function reviveClaudeTabs() {
    if (!shared.cfg().get('restoreTabNames')) return;
    firstPassDone = true;               // from here on, a late tab re-runs this (restoreBinding)
    const saved = pendingOrder;
    pendingOrder = [];
    if (!saved.length) return;
    const terms = vscode.window.terminals;
    // Sessions that found no tab THIS pass, while the window still has fewer tabs than
    // were saved: kept pending, to be paired with the tabs still arriving. The first
    // pass runs when the tab set has merely gone QUIET for a while - and on a slow cold
    // boot the panel's tabs come back seconds before the editor area's do, so it once
    // ran with 4 of 14 tabs present, paired the 4 sessions with 4 panel shells the user
    // had been typing in, left those alone (rightly), and was over by the time the 4
    // claude tabs actually arrived: nothing left to pair them with. The saved list is
    // held while this waits (saveBindings) - these sessions are not lost yet.
    const holdRest = (left) => {
        if (!left.length || terms.length >= savedSlotCount || Date.now() >= lateDeadline) return;
        pendingOrder = left;
        if (!keepSaved) keepSaved = { terms: new Set(terms), n: left.length, said: false };
        shared.nlog('revive: ' + left.length + ' session(s) still waiting for a tab - ' +
            terms.length + ' of ' + savedSlotCount + ' tab(s) back so far');
    };
    const titles = new Set(saved.map((e) => e && e.title).filter(Boolean));
    const free = (e) => !!(e && e.sessionId &&
        !shared.claudeRecs.some((r) => r.sessionId === e.sessionId));
    // Every saved pid stale = the app was quit and reopened, so nothing is running in
    // these tabs; a click may safely resume the session right back into one.
    const dead = savedPidCount > 0 && restoredByPid === 0;
    // Three passes, strongest evidence first, each taking only what the one before left:
    //  1. TITLE - a restored tab still wearing exactly the title we saved for a session
    //     is that session's tab wherever it sits (a reload keeps the titles; so does
    //     many a restart, until the relaunched shell writes over them).
    //  2. SLOT - the saved list has a slot for every tab, so with the same number back
    //     slot i IS tab i, however the shells have retitled themselves... as long as
    //     the window brought them back in the order they were saved. It does not
    //     always: the saved order is CREATION order (claude tabs opened between
    //     .terminals batches, a restartAll putting the batch at the end), while a
    //     restart brings them back grouped by LOCATION - the panel's tabs first, the
    //     editor area's after - so in a mixed window every claude slot can land on a
    //     batch tab. That is what emptied a 12-tab window after a restart: 0 pairs,
    //     and (before the pass below) no fallback and no log line to say so. The slots
    //     are ONE hypothesis about the layout, taken whole or not at all: if any
    //     session's slot holds something that is not a claude tab, the order changed,
    //     and a slot that does hold one is a coincidence, not a match.
    //  3. ORDER - whatever is still free pairs left to right with whatever still looks
    //     like a claude tab, the way claude-only state (no placeholders) always has.
    // A tab a previous pass offered and found in use is not offered again: a late pass
    // would only burn another session on it (see triedTouched).
    const loose = new Set(terms.filter((t) => !triedTouched.has(t) && looksLikeClaudeTab(t, titles, dead)));
    const entries = saved.filter(free);
    const wanted = entries.length;
    const bySlot = saved.length === terms.length && saved.some((e) => e && !e.sessionId) &&
        saved.every((e, i) => !free(e) || loose.has(terms[i]));
    const how = { title: 0, slot: 0, order: 0 };
    let pairs = [];
    const take = (e, t, way) => {
        pairs.push({ e, t });
        loose.delete(t);
        entries.splice(entries.indexOf(e), 1);
        how[way]++;
    };
    for (const e of entries.slice()) {
        if (!e.title) continue;
        const worn = [...loose].filter((t) => t.name === e.title);
        if (worn.length === 1) take(e, worn[0], 'title');   // two wearing it = no evidence
    }
    if (bySlot)
        saved.forEach((e, i) => {
            if (entries.includes(e) && loose.has(terms[i])) take(e, terms[i], 'slot');
        });
    const rest = [...loose];                      // a Set keeps terms' order
    for (let i = 0, n = Math.min(entries.length, rest.length); i < n; i++)
        take(entries[0], rest[i], 'order');
    if (!pairs.length) {
        // Said out loud, and the saved list is KEPT (see saveBindings): nothing here
        // matched, but the sessions were real and the next start may do better.
        if (wanted) {
            keepSaved = { terms: new Set(terms), n: wanted, said: false };
            shared.nlog('revive: ' + wanted + ' saved session(s) but none of the ' + terms.length +
                ' restored tab(s) matched' + (loose.size ? '' : ' - no tab looks like a claude tab') +
                ': ' + terms.map((t) => '"' + t.name + '"').join(', '));
            holdRest(entries);
        }
        return;
    }
    const by = ['title', 'slot', 'order'].filter((k) => how[k])
        .map((k) => how[k] + ' by ' + k).join(', ');
    // A cold boot loads the extension late, and a person left at an empty prompt does
    // not wait for it: a restored tab the user has already typed into, or run something
    // in, is THEIR tab now - not paired, not renamed, never closed or typed into. Their
    // own `claude --resume` in it is adopted by adoptClaude like any hand-started claude.
    let busy = 0;
    const dropped = [];
    if (dead) {
        const n = pairs.length;
        pairs = pairs.filter((p) => {
            if (!userTouched(p.t, true)) return true;
            dropped.push(p.e);
            triedTouched.add(p.t);      // not offered to a later pass again
            return false;
        });
        busy = n - pairs.length;
        if (busy) shared.nlog('revive: ' + busy + ' restored tab(s) already in use - left alone');
    }
    // Still waiting, if tabs are still arriving: the sessions nothing matched first, and
    // behind them the ones whose match was a tab in use - that tab may well have been
    // someone else's shell, with the real one not back yet (see holdRest); but if it WAS
    // the session's own tab, typed into, the sessions with no match at all come first
    // for whatever arrives.
    holdRest(entries.concat(dropped));
    if (!pairs.length) {
        // Every pair dropped as in-use: NOTHING is bound, so the saved list is still the
        // only record of these sessions and must not be overwritten with a row of
        // placeholders by the next tick's saveBindings. holdRest cannot hold it here -
        // it only holds while tabs may still be arriving, and this case has every tab
        // back already (9 saved slots, 9 tabs, 9 dropped: 2026-08-23, and the window
        // came back empty of everything on the reload after it, and the one after).
        if (wanted) {
            keepSaved = { terms: new Set(terms), n: wanted, said: false };
            shared.nlog('revive: nothing bound - keeping the saved list of ' + wanted + ' session(s)');
        }
        return;
    }
    // After a restart the tabs are empty shells: put the sessions straight back
    // (autoResume, on by default) rather than leaving each one a light-click away - and
    // not INTO those shells but into fresh terminals of our own in their place; see
    // reopenRevivedTab for why the restored shell is not worth typing into.
    const reopen = dead && shared.cfg().get('autoResume');
    // ...in the shell the user's settings name, read once for the lot.
    const sh = reopen ? preferredShell() : null;
    if (reopen) shared.nlog('revive: reopening in ' + (sh ? sh.shellPath : 'the default profile'));
    const revived = [], inPlace = [], rename = [];
    let reopened = 0;
    for (const { e, t } of pairs) {
        if (reopen) {
            const fresh = reopenRevivedTab(e, t, sh);
            if (fresh) { reopened++; revived.push({ rec: fresh, title: e.title }); continue; }
        }
        const rec = { terminal: t, cwd: e.cwd, created: e.created, sessionId: e.sessionId,
            lastTitle: '', inEditor: e.inEditor, pid: 0, resumeId: '', continueFlag: false,
            revived: dead };
        shared.claudeRecs.push(rec);
        t.processId.then((pid) => { rec.pid = pid || 0; }, () => { });
        revived.push({ rec, title: e.title });
        rename.push({ rec, title: e.title });
        if (reopen) inPlace.push(rec);      // could not be reopened: resume in place instead
    }
    const resumed = reopened + (inPlace.length ? autoResumeRevived(inPlace) : 0);
    shared.nlog('revive: re-bound ' + revived.length + ' claude tab(s) (' + by + ')' +
        (dead ? ' after a restart' : '') +
        (resumed ? ' - resumed ' + resumed + ' of them' +
            (reopened ? ' (' + reopened + ' in fresh terminals)' : '') : ''));
    // A reopened tab was born wearing its title; only the ones left in place need the flick.
    if (rename.length) renameRevivedTabs(rename);
}

/// After a full quit or a reboot the tab VS Code brings back is nothing we want to type
/// into. The pty host died with the app, and what the workbench relaunched in the tab
/// is whatever it had to hand at that moment: on a slow cold boot its profile detection
/// may not have found the configured default yet, so the tab comes up in the OS
/// fallback shell (Windows PowerShell on a Git Bash machine), and a revived process is
/// relaunched with the environment saved before the quit, not today's. A `claude
/// --resume` typed into that is `claude : The term 'claude' is not recognized` in a
/// shell the user never chose - which is exactly what a reboot produced. So the restored
/// shell is closed and the session reopened in a terminal of our own, with every setting
/// a claude tab ever gets: the session's title as its NAME (no rename flick needed - it is
/// born wearing it), the model letter on the icon, the session's cwd, a fresh
/// environment, and the title-stomp guard. A panel tab is created as a SPLIT of the dead
/// tab, so that when the dead one goes the replacement is left standing in its slot
/// rather than at the end of the row; an editor-area tab goes to the active column, as
/// a light-click's resume does. The rec is bound to the session on the spot (the id is
/// known - it is what was saved), so the light, the hover and the title sweep all see
/// a live tab from the first tick. Returns the rec, or null if no terminal could be
/// opened - the caller then resumes into the restored shell the old way.
/// Has the user already got to this restored tab - typed into it, or run something in
/// it - before the revive reached it? `state.isInteractedWith` is the workbench's own
/// "input went to this terminal" flag - false for every tab a window restores, set by
/// the first byte xterm writes to the process: a keystroke, but also a sendText (so it
/// is read BEFORE anything is typed into the tab) and a focus-in report from a program
/// that asked for focus tracking, which is why it says nothing useful about a tab that
/// is running claude (refreshTabMarks). The set is belt and braces for a shell whose
/// integration reported a command starting, which is the same fact by another route.
///
/// It was read as meaning what it says for a restored shell after a quit - a bare shell,
/// nothing running, nothing to track focus - and that was wrong, expensively. The
/// workbench sets the flag from `onAnyInstanceDataInput`, and xterm counts as INPUT the
/// replies it sends back on the terminal's own behalf: the device-attributes, cursor
/// position and focus-in reports the buffer VS Code replays into a revived tab asks for.
/// The scrollback a claude tab comes back with turns focus reporting on again, so the tab
/// answers its own replayed history within seconds of the restore and reads as
/// typed-into with nobody at the keyboard - the same fact refreshTabMarks learned the
/// hard way on 2026-08-22, one restore earlier in the same startup.
/// Seen 2026-08-23: nine restored tabs, all nine "already in use" in the same second,
/// while identify.sweepNow had just reported no live claude process anywhere - and the
/// revive that stood aside for them cost the window every binding it had (reviveClaudeTabs).
///
/// So `restoring` - the pass that runs while the window is coming back, where the replay
/// is happening and the flag is noise - asks only whether a command actually RAN in the
/// tab, which no replay can fake. Everywhere else the flag is still read, but only for
/// the terminal that has FOCUS: a person can only be typing a draft into the tab they
/// are looking at, while the replayed queries flag every tab at once.
const touchedTerms = new WeakSet();
function userTouched(t, restoring) {
    if (touchedTerms.has(t)) return true;
    if (restoring) return false;
    if (t !== vscode.window.activeTerminal) return false;
    try { return !!(t.state && t.state.isInteractedWith); } catch { return false; }
}

/// The shell the user has told VS Code to open terminals in, read from THEIR settings
/// (`terminal.integrated.defaultProfile.<os>` and the matching `profiles.<os>` entry)
/// and resolved here - so a reopened tab is started in that shell directly, rather than
/// through the workbench's default-profile resolution, which on a slow cold boot may
/// not have detected that shell yet and quietly substitutes the OS fallback (Windows
/// PowerShell): the very thing the reopen exists to get away from. A `path` profile is
/// used as written (first path that exists, `${env:X}` expanded, its args and env
/// carried); the built-in "Git Bash" source is looked up where VS Code itself looks,
/// with the args VS Code gives it. Anything else - no default set, a PowerShell or WSL
/// source, a path that is not there - answers null, and the terminal is left to the
/// workbench's default as before: guessing wrong here would open the session in a shell
/// the user never chose, which is the bug, not a fix for it. Pure given `opts`
/// (cfg/os/env/exists), which is how the smoke test pins it from any machine.
const GIT_BASH_PATHS = [
    '${env:ProgramW6432}\\Git\\bin\\bash.exe', '${env:ProgramW6432}\\Git\\usr\\bin\\bash.exe',
    '${env:ProgramFiles}\\Git\\bin\\bash.exe', '${env:ProgramFiles}\\Git\\usr\\bin\\bash.exe',
    '${env:LocalAppData}\\Programs\\Git\\bin\\bash.exe',
    '${env:UserProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe',
    '${env:AllUsersProfile}\\scoop\\apps\\git\\current\\bin\\bash.exe'
];
const PROFILE_OS = { win32: 'windows', darwin: 'osx' }[process.platform] || 'linux';
function preferredShell(opts) {
    const o = opts || {};
    const cfg = o.cfg || vscode.workspace.getConfiguration('terminal.integrated');
    const os = o.os || PROFILE_OS;
    const env = o.env || process.env;
    const exists = o.exists || ((p) => { try { return require('fs').statSync(p).isFile(); } catch { return false; } });
    const name = cfg.get('defaultProfile.' + os);
    if (!name || typeof name !== 'string') return null;
    const profiles = cfg.get('profiles.' + os) || {};
    const p = profiles[name];
    // Only ${env:X} is expanded: a path still holding a ${...} after that is one we
    // cannot resolve, and is skipped rather than statted as written.
    const subst = (s) => String(s).replace(/\$\{env:([^}]+)\}/g, (_, k) => env[k] || '');
    const pick = (paths) => [].concat(paths || []).map(subst)
        .find((x) => x && !/\$\{/.test(x) && exists(x));
    if (p && p.path) {
        const path = pick(p.path);
        if (!path) return null;
        const sh = { shellPath: path, shellArgs: [].concat(p.args || []).map(subst) };
        if (p.env && typeof p.env === 'object') sh.env = p.env;
        return sh;
    }
    const source = p && typeof p.source === 'string' ? p.source : (p ? '' : name);
    if (os === 'windows' && source === 'Git Bash') {
        const path = pick(GIT_BASH_PATHS);
        return path ? { shellPath: path, shellArgs: ['--login', '-i'] } : null;
    }
    return null;
}

function reopenRevivedTab(e, t, sh) {
    if (!safeId(e.sessionId)) return null;
    const s = shared.sessions.get(e.sessionId);
    const name = s && s.name ? lights.lightFor(s).e + ' ' + s.name : (e.title || 'claude');
    // The session's launch folder first (see resumeSession) - the saved tab cwd may
    // itself be a resume opened where the session's Bash tool had wandered.
    const cwd = (s && s.home) || e.cwd || shared.firstRoot();
    const inEditor = !!e.inEditor;
    const wasActive = vscode.window.activeTerminal === t;
    const letter = modelLetter(s && s.model);
    let terminal;
    try {
        const opts = {
            name,
            cwd,
            ...shared.tabMark(letter),
            location: inEditor ? { viewColumn: activeViewColumn() } : { parentTerminal: t },
            env: Object.assign({}, sh && sh.env, { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' })
        };
        // The user's own default shell, started directly (preferredShell) - or, where
        // that could not be read, the workbench's default profile as for any terminal.
        if (sh && sh.shellPath) { opts.shellPath = sh.shellPath; opts.shellArgs = sh.shellArgs; }
        terminal = vscode.window.createTerminal(opts);
    } catch (err) {
        shared.nlog('revive: could not reopen ' + e.sessionId.slice(0, 8) + ' - ' +
            (err && err.message ? err.message : err) + ' - resuming in place');
        return null;
    }
    try { t.dispose(); } catch { /* already gone */ }
    const rec = { terminal, cwd, created: e.created, sessionId: e.sessionId, lastTitle: name,
        inEditor, pid: 0, resumeId: e.sessionId, continueFlag: false, revived: false, letter };
    shared.claudeRecs.push(rec);
    terminal.processId.then((pid) => { rec.pid = pid || 0; saveBindings(); }, () => { });
    // The tab the window came back looking at stays the one in front - its replacement,
    // now. Focus is not taken.
    if (wasActive) { try { terminal.show(true); } catch { } }
    // A session with no transcript (never spoken to) gets a plain `claude` and an unbound
    // rec instead - resuming it would only print "No conversation found" into the tab.
    const cmd = reviveCommand(rec, e.sessionId, cwd);
    try { terminal.sendText(cmd, true); }
    catch (err) { shared.nlog('resume: ' + e.sessionId.slice(0, 8) + ' - ' + err.message); }
    return rec;
}

/// A tab revived after a full quit or a reboot wears its session's name but has nothing
/// running in it - the pty host died with the app, and the shell VS Code relaunched is
/// a fresh one. This types `claude --resume <id>` into each such tab, which is exactly
/// what a click on its light would do (showSession), so the session comes back in the
/// same tab, in the same place, without anyone having to click it. It is the FALLBACK
/// now - reopenRevivedTab replaces the restored shell with a terminal of our own, and
/// only a tab it could not reopen is resumed in place like this. The same rec fields
/// are set as that click sets: `revived` off so nothing types a second resume over the
/// top, `resumeId` so bindClaudeTerminals pairs the transcript that starts moving with
/// THIS tab and not with the oldest unbound terminal in the folder. The shell may still
/// be initialising on a cold boot; typed-ahead input waits in the pty until it reads.
/// Returns how many were resumed.
function autoResumeRevived(recs) {
    let n = 0;
    for (const rec of recs) {
        if (!rec.revived || !vscode.window.terminals.includes(rec.terminal)) continue;
        if (!safeId(rec.sessionId)) continue;
        const id = rec.sessionId;
        rec.revived = false;
        rec.resumeId = id;
        // ...or a plain `claude` (rec unbound) when the session has no transcript to
        // resume - see reviveCommand.
        const cmd = reviveCommand(rec, id, rec.cwd);
        try { rec.terminal.sendText(cmd, true); n++; }
        catch (e) { shared.nlog('resume: ' + id.slice(0, 8) + ' - ' + e.message); }
    }
    return n;
}

/// Every bound claude tab whose MARK no longer says what its session is running,
/// reopened wearing the right letter. VS Code freezes a terminal's icon at creation and
/// offers no way to change it afterwards (shared.tabMark), so a tab launched as a
/// plain `claude` - the "C" - kept the "C" for ever, however long the transcript had
/// been naming the model that answers in it, and a tab whose session moved on with
/// `/model` kept the letter it was launched with. And a window RELOAD takes the letter
/// off every tab: the file-URI icon a terminal was created with does not come back with
/// the reconnected process - the tab comes up wearing the workbench's default mark
/// (seen 2026-08-22: four lettered tabs, four "≡" after the reload) - and the pid
/// re-bind (restoreBinding) could not put it back, while after a full quit every tab is
/// reopened from scratch (reopenRevivedTab) and so DOES come back wearing the letter the
/// transcript names. This closes both gaps, on the two occasions the user has asked for
/// the tabs to be brought up to date - the window loading, and the "Refresh tab names"
/// command: the same reopen as after a quit (a fresh terminal of ours in the tab's
/// place, born wearing the title and the letter, `claude --resume <id>` typed into it),
/// for a tab whose letter is WRONG or MISSING (`rec.letter`: what the mark was created
/// with; undefined for a reload-survivor, whose mark the reload dropped, and for an
/// adopted terminal nobody made).
///
/// A reopen kills the claude in that tab and resumes the session into a new one, so it
/// is done only where that costs nothing that can be seen: the session must be idle at
/// its prompt (🔴 - not mid-turn, not waiting on a permission or a question, not
/// processing in the background), its own status file - when it has a fresh one - must
/// say idle too, and its transcript must have been quiet for MARK_QUIET_MS: the tail
/// between two records of one turn can read as a finished turn, and the detf window's
/// first pass (2026-08-22 04:21) reopened "shares" eight seconds after it had been
/// processing - mid-turn, which a resume cannot put back. Twenty seconds costs nothing:
/// the poll keeps trying for a minute after load, and a finished turn writes once
/// (turn_duration) and then falls silent. What the prompt box is SHOWING cannot be read from
/// here - the process survived the reload and its screen is its own - and the one flag
/// the API offers, `state.isInteractedWith` (userTouched), is no stand-in for "a draft
/// is typed here": it is set by ANY byte xterm sends the process, and claude turns focus
/// reporting on (DECSET 1004), so the tab the window comes back looking at reports its
/// focus-in (`ESC [ I`) the moment it is restored and is "interacted with" before
/// anyone has touched a key. With that guard the active tab - the one the user is
/// actually looking at, and the one they most want right - was the one left wearing the
/// wrong letter every time, while a history suggestion sitting in its prompt (ghost
/// text, Tab to take) was never at risk: it comes back with the resume. So it is not
/// consulted here; a draft typed and not sent is resumed fresh, which the manual says.
///
/// The window-loaded pass is not one shot: the first run is the moment the restored tabs
/// have settled, but a tab's pid can resolve after that, the scan may not have read its
/// session yet (the first scan and the settle race), and a session mid-turn at load is
/// idle a poll later - so the poll runs it again (pollTabMarks) for RESTORE_MAX_MS after
/// load. The 2026-08-22 reload that "did nothing" logged no marks line at all: every tab
/// fell through one of the silent early-outs below, which is why each pass now says what
/// it saw - once per distinct picture, not every five seconds. Returns how many tabs
/// were reopened.
let marksDue = 0;       // until when pollTabMarks keeps running the window-loaded pass
let marksSaid = '';     // the last picture logged, so a quiet poll says nothing new
const MARK_QUIET_MS = 20_000;   // no transcript write for this long before a tab is reopened
// Reopens per pass. Each reopen opens the new tab BEFORE the old one is torn down (a
// panel tab is split off it), so a burst holds two consoles per tab for a moment - and
// Git Bash (MSYS) allows 32 consoles in all: the detf window's first pass reopened
// eleven tabs at once, on top of the .terminals servers, and a new tab's shell died
// with "console device allocation failure - too many consoles in use, max consoles is
// 32" (2026-08-22). Two per pass, five seconds apart, keeps the count flat; the poll
// carries the rest (pollTabMarks - armTabMarks keeps it going for the command too).
const MARKS_PER_PASS = 2;
function refreshTabMarks(why) {
    let sh = null, read = false, n = 0, held = 0;
    const skipped = [];
    const seen = { right: 0, unbound: 0, unscanned: 0, unknown: 0 };
    for (const rec of shared.claudeRecs.slice()) {
        if (!vscode.window.terminals.includes(rec.terminal)) continue;
        if (!rec.sessionId || rec.revived) { seen.unbound++; continue; }
        const s = shared.sessions.get(rec.sessionId);
        if (!s) { seen.unscanned++; continue; }
        const letter = modelLetter(s.model);
        if (!letter) { seen.unknown++; continue; }            // nothing known to fix
        if (letter === rec.letter) { seen.right++; continue; }   // already right
        const who = (s.name || rec.sessionId.slice(0, 8)) + ' (' +
            (rec.letter === undefined ? '?' : rec.letter ? rec.letter.toUpperCase() : 'C') +
            ' -> ' + letter.toUpperCase() + ')';
        const idle = s.state === 'awaiting' && !s.background && !s.waiting && !s.question;
        if (!idle) { skipped.push(who + ' - ' + lights.lightFor(s).label); continue; }
        // ...by the CLI's own account too, and quiet long enough to be believed.
        if (s.cliStatus && s.cliStatus !== 'idle') {
            skipped.push(who + ' - the CLI says "' + s.cliStatus + '"'); continue;
        }
        const quiet = Date.now() - (s.lastWriteMs || 0);
        if (quiet < MARK_QUIET_MS) {
            skipped.push(who + ' - wrote ' + Math.round(quiet / 1000) + 's ago, waiting for it to settle'); continue;
        }
        if (!safeId(rec.sessionId)) continue;
        if (n >= MARKS_PER_PASS) { held++; continue; }   // the next pass takes it
        if (!read) { read = true; sh = preferredShell(); }
        // Out of the list BEFORE the old tab is disposed: claudeTabClosed would otherwise
        // read the close as the user shutting the session and retire its light.
        const i = shared.claudeRecs.indexOf(rec);
        if (i >= 0) shared.claudeRecs.splice(i, 1);
        const fresh = reopenRevivedTab({ sessionId: rec.sessionId, cwd: rec.cwd, created: rec.created,
            inEditor: rec.inEditor, title: rec.lastTitle }, rec.terminal, sh);
        if (!fresh) { shared.claudeRecs.splice(Math.min(i, shared.claudeRecs.length), 0, rec); continue; }
        shared.nlog('marks: ' + why + ' - reopened ' + who + ' wearing its letter');
        n++;
    }
    // What the pass saw, said once per distinct picture: the poll re-runs the
    // window-loaded pass every five seconds for a minute, and a quiet one says nothing.
    const parts = [];
    if (seen.right) parts.push(seen.right + ' wearing the right letter');
    if (seen.unbound) parts.push(seen.unbound + ' not bound to a session yet');
    if (seen.unscanned) parts.push(seen.unscanned + ' whose session the scan has not read');
    if (seen.unknown) parts.push(seen.unknown + ' whose model is not known');
    if (skipped.length) parts.push(skipped.length + ' left wearing the wrong letter: ' + skipped.join('; '));
    if (held) parts.push(held + ' more next pass');
    const picture = why + '|' + parts.join('|');
    if (n || (parts.length && picture !== marksSaid)) {
        marksSaid = picture;
        const total = seen.right + seen.unbound + seen.unscanned + seen.unknown + skipped.length + n + held;
        shared.nlog('marks: ' + why + ' - ' + total + ' claude tab(s)' +
            (n ? ', ' + n + ' reopened' : '') + (parts.length ? ': ' + parts.join(', ') : ''));
    }
    if (n) saveBindings();
    return n;
}

/// The window-loaded pass again, from the poll (shutdown.tick), for RESTORE_MAX_MS after
/// load - see refreshTabMarks. Nothing to do, nothing said.
function pollTabMarks() {
    if (!marksDue) return 0;
    if (Date.now() > marksDue) { marksDue = 0; return 0; }
    return refreshTabMarks(marksWhy);
}
let marksWhy = 'window loaded';   // what the poll's passes are labelled

/// Start (or restart) the paced passes - loadPendingBindings at window load, and the
/// "Refresh tab names" command: one pass now, then the poll every five seconds for
/// RESTORE_MAX_MS, MARKS_PER_PASS reopens each, until every tab is right or the time
/// is up. Returns what the first pass reopened.
function armTabMarks(why) {
    marksDue = Date.now() + RESTORE_MAX_MS;
    marksSaid = '';
    marksWhy = why;
    return refreshTabMarks(why);
}

/// Only the ACTIVE terminal can be renamed, so each tab in the list is revealed in turn
/// (focus is never taken) and renamed; the tab the user was left looking at goes back
/// in front at the end. A one-off flick through the claude tabs, never a habit: it is
/// the price of the workbench having no "rename that other tab" command.
async function flickTabs(list) {
    const prevTerminal = vscode.window.activeTerminal;
    const prevEditor = vscode.window.activeTextEditor;
    for (const { rec, title } of list) {
        if (!title || !vscode.window.terminals.includes(rec.terminal)) continue;
        try {
            rec.terminal.show(true);
            await shared.sleep(150);
            // renameWithArg renames whatever tab is ACTIVE when it RUNS - so if the
            // reveal did not take (a tab closing under us, the user clicking another
            // one mid-flick), stamping now would put this session's word on somebody
            // else's tab. Skip it; the poll gets that tab when it is active anyway.
            if (vscode.window.activeTerminal !== rec.terminal) {
                shared.nlog('rename: "' + title + '" skipped - the reveal did not take');
                continue;
            }
            // The LIGHT is read here, not when the list was built. A ten-tab flick is a
            // second and a half of sleeps plus however long it waited in the queue, and
            // a session that finishes its turn inside that window was stamped with the
            // 🟢 it had when the list was made - with rec.lastTitle agreeing, so nothing
            // corrected it until the tab was next active. The title the caller passed
            // stands in only when the session has gone from the scan.
            const s = shared.sessions.get(rec.sessionId);
            const now = s && s.name ? lights.lightFor(s).e + ' ' + s.name : title;
            await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: now });
            // ...and the same race again on the way OUT: the workbench renames whatever
            // is active when IT runs the command, so a click landing in that window puts
            // this word on a tab that is not this session's. renameActiveClaude is the
            // one that knows what any tab ought to be wearing: an UNBOUND one is stripped
            // back to its own name (repairStolenTitle - and no poll would ever reach it,
            // so this is its only chance), a BOUND one is re-stamped with its OWN
            // session's title. Not repairStolenTitle directly: that would rename a bound
            // victim to the name it was BORN with - "claude" - and then, because the
            // focus restore below moves off it, no poll would reach that tab either
            // until the user next clicked it. Waited on, not fired off: the restore
            // would otherwise get to the workbench first and take the repair with it.
            if (vscode.window.activeTerminal !== rec.terminal) {
                shared.nlog('rename: "' + now + '" landed after focus moved - repairing');
                await renameActiveClaude();
                continue;
            }
            rec.lastTitle = now;
        } catch { /* tab closed mid-sweep */ }
    }
    try {
        if (prevTerminal && vscode.window.terminals.includes(prevTerminal)) prevTerminal.show(true);
        else if (prevEditor) await vscode.window.showTextDocument(prevEditor.document,
            { viewColumn: prevEditor.viewColumn, preserveFocus: true });
    } catch { }
    saveBindings();
}

/// Two flicks at once would fight over which tab is active - and the second one's
/// "does this tab need renaming?" answers are only worth anything once the first has
/// finished stamping. So they queue, and a sweep waits for the queue before it looks.
let flickQueue = Promise.resolve();
function queueFlick(list) {
    const run = () => flickTabs(list);
    flickQueue = flickQueue.then(run, run);
    return flickQueue;
}

/// The titles on a revived list are the ones the LAST window saved, which are a window
/// old and may have no session behind them at all. flickTabs resolves each one against
/// the live session as it reveals the tab, so they are only the fallback.
function renameRevivedTabs(list) { return queueFlick(list); }

/// Every bound claude tab that is not wearing its session's title, renamed in one pass.
///
/// renameActiveClaude only ever reaches the ACTIVE tab, which is all the poll needs
/// while you work - but at startup nothing is active except the one tab the window
/// happened to restore in front, so every OTHER claude tab sat there nameless until it
/// was clicked. reviveClaudeTabs covered exactly one route in (the after-a-full-quit
/// pairing); tabs re-bound by pid after a reload, and tabs identified from claude's own
/// pid files, both came back bound-but-unstamped. This is that same flick, run over
/// whatever is bound however it got bound.
async function sweepTabTitles(why) {
    await flickQueue.catch(() => { });      // ...and read the titles AFTER it, not before
    // A hand-rename this window has not seen yet. The poll adopts them - every bound
    // tab, not just the active one - but the sweep's own caller is "window loaded",
    // which runs before the first poll of the window has, and the names on restored
    // tabs are whatever the workbench brought back. Sweeping first would stamp the
    // session's old word over such a title AND set rec.lastTitle to that stamp, which
    // is exactly what adoptManualRenames takes as "that title is ours" - so the typed
    // word would not be adopted late, it would be gone.
    adoptManualRenames();
    const list = [];
    for (const rec of shared.claudeRecs) {
        if (!rec.sessionId || !vscode.window.terminals.includes(rec.terminal)) continue;
        const s = shared.sessions.get(rec.sessionId);
        if (!s || !s.name) continue;
        const title = lights.lightFor(s).e + ' ' + s.name;
        // The worn title, not rec.lastTitle: a tab we never got to has a lastTitle of
        // '' but so does a tab the user renamed by hand, and what is actually on the
        // tab is the only thing that says whether this flick is worth its flicker.
        if (String(rec.terminal.name || '').trim() === title) continue;
        list.push({ rec, title });
    }
    if (!list.length) return 0;
    shared.nlog('rename: ' + why + ' - flicking through ' + list.length + ' tab(s)');
    await queueFlick(list);
    return list.length;
}

/// Claude terminals live in the MAIN EDITOR AREA (real editor tabs), not the bottom
/// panel — unless openInEditorArea is turned off. The CONCRETE view column of the
/// current group is passed, because VS Code mishandles ViewColumn.Active for terminal
/// editors and opens a split instead (microsoft/vscode#131595, #166241).
function activeViewColumn() {
    const g = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup;
    return g ? g.viewColumn : vscode.ViewColumn.One;
}

function claudeLocation() {
    return shared.cfg().get('openInEditorArea')
        ? { viewColumn: activeViewColumn() }
        : vscode.TerminalLocation.Panel;
}

/// Backstop for the same VS Code bug: if the terminal tab still landed in a NEW split
/// group instead of the requested one, walk it back group by group.
function settleIntoGroup(targetCol, tries) {
    if (tries === undefined) tries = 3;
    if (!shared.cfg().get('openInEditorArea')) return;
    setTimeout(() => {
        const g = vscode.window.tabGroups.activeTabGroup;
        const tab = g && g.activeTab;
        if (!g || !tab || g.viewColumn === targetCol || tries <= 0) return;
        if (!(tab.input instanceof vscode.TabInputTerminal)) return;
        vscode.commands.executeCommand(g.viewColumn > targetCol
            ? 'workbench.action.moveEditorToPreviousGroup'
            : 'workbench.action.moveEditorToNextGroup')
            .then(() => settleIntoGroup(targetCol, tries - 1), () => { });
    }, 400);
}

/// The launch buttons: ONE status bar entry per claudeButtons entry ("opus", "fable",
/// "sonnet", "haiku" - and "sol", "terra", "luna", "mini" for Codex), each opening a
/// terminal pinned to that model: `claude --model` for a Claude model, `codex -m` for
/// an OpenAI one. Entries are "label = model" (or just "model"); edits to the setting
/// rebuild the buttons live.
const claudeButtons = [];
const claudeButtonEntries = [];   // {label, model} behind each item, same order

/// The text on a launch button: its letter, and its word while the bar has room for one
/// (density.js decides - a crowded bar takes the labels off first, they are the one thing
/// down there whose meaning the mark already carries).
function buttonText(b) { return density.buttonText(letterIcon(b.model), b.label); }

/// Re-write every button's text for the CURRENT density level, touching nothing else.
/// lights.renderSessions calls this when the level moves; a rebuild (buildClaudeButtons)
/// is for a change of which buttons there are.
function paintClaudeButtons() {
    for (let i = 0; i < claudeButtons.length; i++) {
        const text = buttonText(claudeButtonEntries[i]);
        if (claudeButtons[i].text !== text) claudeButtons[i].text = text;
    }
}

/// The words the buttons would wear at full size - what density.js budgets for.
function buttonLabels() { return claudeButtonEntries.map((b) => b.label); }

/// The models the "Choose Models" picker offers, in BUTTON ORDER - which is also the
/// order of the editor title letter icons: the four Claude models (O / F / S / H, in
/// orange) and then the four OpenAI models Codex's own /model picker leads with
/// (S / T / L / M, in blue). `best` is what the hover says the model is for: choosing
/// between eight buttons is guesswork without it. `vendor` is which CLI a button types
/// into its terminal - `claude --model` or `codex -m` - and which colour its letter
/// wears: Sol and Sonnet share the S, and the colour is the only thing that tells the
/// two marks apart on a crowded bar, so the letters carry one everywhere they appear.
/// `letter` is the static resource the mark draws from (media/letter-*.svg for the
/// editor title bar and the tab, a glyph in media/chutdown.ttf for the status bar).
/// How many of the catalog's models have an editor title icon - the number of
/// newClaudeSlotN commands and editor/title entries in package.json, each with its own
/// letter resource. A ninth catalog model would need a ninth of all three.
const MODEL_CATALOG = [
    { label: 'opus', model: 'claude-opus-5', name: 'Claude Opus 5', vendor: 'claude', letter: 'o',
      best: 'The everyday workhorse. Complex agentic coding, multi-file features, larger refactors, long autonomous runs. Start here.' },
    { label: 'fable', model: 'claude-fable-5', name: 'Claude Fable 5', vendor: 'claude', letter: 'f',
      best: 'The most capable model, and the most expensive. Keep it for the hardest reasoning and the longest-horizon work - the tasks Opus does not finish.' },
    { label: 'sonnet', model: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'claude', letter: 's',
      best: 'Near-Opus quality on coding and agentic work at a fraction of the cost. The cost-conscious pick for ordinary tasks.' },
    { label: 'haiku', model: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', vendor: 'claude', letter: 'h',
      best: 'Fastest and cheapest. Easy, well-scoped jobs: quick edits, renames, lookups, summaries, boilerplate.' },
    { label: 'sol', model: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', vendor: 'openai', letter: 's',
      best: 'OpenAI\'s frontier model, and Codex\'s default: complex coding, research and long real-world tasks. The Opus of the blue side - and the other S.' },
    { label: 'terra', model: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', vendor: 'openai', letter: 't',
      best: 'Balanced quality, latency and cost. The everyday agentic coding pick when Sol is more than the job needs.' },
    { label: 'luna', model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', vendor: 'openai', letter: 'l',
      best: 'Fast and affordable agentic coding. High-throughput, lower-latency work.' },
    { label: 'mini', model: 'gpt-5.4-mini', name: 'GPT-5.4 mini', vendor: 'openai', letter: 'm',
      best: 'Small, fast and cost-efficient. Simple, well-scoped coding tasks - the Haiku of the blue side.' }
];
const TITLE_SLOTS = MODEL_CATALOG.length;

/// What a model is good for, for the hover. Exact id first, then a family match, so a
/// pinned snapshot ("claude-haiku-4-5-20251001") still finds its blurb - and an Azure
/// deployment named for its model ("gpt-5-mini", "gpt-5.1-codex-mini") its letter.
function modelInfo(model) {
    const id = String(model || '').trim();
    if (!id) return null;
    return MODEL_CATALOG.find((m) => m.model === id) ||
        MODEL_CATALOG.find((m) => id.startsWith(m.model)) ||
        MODEL_CATALOG.find((m) => id.includes(m.label)) || null;
}

/// Which CLI a model belongs to - 'claude' or 'openai' (Codex). The catalog says for
/// its own; a hand-typed id is read off its name, since an OpenAI id never starts with
/// "claude-" and a Claude one never with "gpt-", "o3"/"o4" or "codex". Unknown = claude:
/// that is what every button launched before there was a second CLI, and a wrong guess
/// there costs a claude that says "no such model", not a codex typed at claude.
const OPENAI_ID = /^(?:gpt-|o\d|codex|chatgpt)/i;
function modelVendor(model) {
    const info = modelInfo(model);
    if (info) return info.vendor;
    return OPENAI_ID.test(String(model || '').trim()) ? 'openai' : 'claude';
}

/// The colour a vendor's letters wear in the STATUS BAR - a status bar item has one
/// colour for all its text (the letter and the word), so the whole button takes it. The
/// SVGs the editor title bar and the tabs use carry their own (media/letter-*.svg: the
/// orange and blue pair per theme). Light enough to read on either of the two status
/// bars VS Code ships - the blue one and the dark one.
const VENDOR_COLOR = { claude: '#EFA07A', openai: '#8FC6FF' };
function vendorColor(model) { return VENDOR_COLOR[modelVendor(model)]; }

/// The tab mark for a codex terminal: its model's blue letter, or - for a model with
/// no letter - a plain sparkle in the same blue, never the Chutdown "C", which says "a
/// claude tab we manage", and this is neither. Spread into createTerminal's options.
function codexMark(model) {
    const l = modelLetter(model);
    return l ? shared.tabMark(l, 'openai')
             : { iconPath: new vscode.ThemeIcon('sparkle'), color: new vscode.ThemeColor('terminal.ansiBlue') };
}

function parseClaudeButtons() {
    const raw = shared.cfg().get('claudeButtons');
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const entry of list) {
        const line = String(entry || '').trim();
        if (!line) continue;
        const eq = line.indexOf('=');
        const label = (eq > 0 ? line.slice(0, eq) : line.split(/\s+/)[0]).trim();
        const model = (eq > 0 ? line.slice(eq + 1) : line).trim();
        if (!label || !model) continue;
        // The model is TYPED INTO A SHELL (`claude --model <model>`, newline and all),
        // so it has to be a model id and nothing else. A workspace's own
        // .vscode/settings.json can set this, and "opus = claude-opus-5 & <anything>"
        // would put a normal-looking button in the status bar that runs the rest on
        // click. A model id is [A-Za-z0-9._-]; anything else is not one.
        if (!/^[A-Za-z0-9._-]+$/.test(model)) {
            shared.nlog('claudeButtons: ignoring "' + line + '" - "' + model +
                '" is not a model id (letters, digits, . _ - only)');
            continue;
        }
        out.push({ label, model });
    }
    // The PACKAGED default is this extension's guess at a good four buttons, and a guess
    // has no business offering an account a model it cannot launch: on a plan without
    // Fable, the default list quietly loses its Fable button. A list the user CHOSE is
    // honoured exactly as written - tick Fable in the picker and you get a Fable button,
    // plan or no plan - because the CLI, not this extension, is the authority on what an
    // account may run, and a misreading here must never be a thing you cannot undo.
    if (buttonsAreDefault()) {
        const allowed = out.filter((b) => usage.modelAvailability(b.label).available);
        if (allowed.length) return allowed;      // ...but never filter the list down to nothing
    }
    // An emptied setting still deserves a way to open claude at all.
    return out.length ? out : [{ label: 'claude', model: '' }];
}

/// Is `claudeButtons` still the packaged default, rather than a list someone chose?
/// inspect() reports the value per scope; none of them set means nothing but the
/// default is in play.
function buttonsAreDefault() {
    const i = shared.cfg().inspect('claudeButtons') || {};
    return i.globalValue === undefined && i.workspaceValue === undefined &&
        i.workspaceFolderValue === undefined;
}

function buildClaudeButtons() {
    for (const it of claudeButtons) it.dispose();
    claudeButtons.length = 0;
    claudeButtonEntries.length = 0;
    const entries = parseClaudeButtons();
    let prio = 998;
    for (const b of entries) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, prio);
        prio -= 0.01;
        item.command = { command: 'chutdown.newClaude', arguments: [b.model], title: 'New' };
        item.text = buttonText(b);
        item.color = vendorColor(b.model);     // orange = claude, blue = codex
        item.tooltip = buttonHover(b);
        item.show();
        claudeButtons.push(item);
        claudeButtonEntries.push(b);
    }
    // The same buttons also sit top-right in the editor title bar as letter icons
    // (package.json editor/title menu, slots 1-4: O/F/S/H in orange, 5-8: S/T/L/M in
    // blue, negative navigation order so they sit leftmost in that row). One context key
    // per slot, each showing that slot only when its model is among the buttons - and
    // none of them when editorTitleButtons is off.
    // VS Code draws at most SEVEN of them: the editor-title toolbar is built with
    // overflowBehavior {maxItems: 9}, its own split-editor button is exempt from hiding
    // but still counted, and the hide test is `count >= max - exempt` - so the 8th
    // extension icon (the blue M, with all eight ticked) is filed under the row's "..."
    // menu, where its command title is the label. Nothing to do about it from here; the
    // status bar has no such cap, and the setting's description says so.
    const titleIcons = shared.cfg().get('editorTitleButtons');
    const slots = slotEntries(entries);
    for (let i = 0; i < TITLE_SLOTS; i++)
        vscode.commands.executeCommand('setContext', 'chutdown.slot' + (i + 1),
            !!(titleIcons && slots[i]));
}

/// The hover on a launch button. A model id alone does not say WHEN to reach for it,
/// and the status bar has room for a label and nothing else - so the "best used for"
/// line lives here, with a link to the picker for changing which buttons are here.
function buttonHover(b) {
    const info = modelInfo(b.model);
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['chutdown.pickModels'] };   // the link below
    md.supportThemeIcons = true;
    // Not escaped, and it does not need to be: parseClaudeButtons only ever yields a
    // model matching [A-Za-z0-9._-], and the label comes from the catalog. Escaping a
    // validated id here would be worse than useless - inside the code span below a
    // backslash is literal, so `claude-opus-5` would render as `claude\-opus\-5`.
    md.appendMarkdown(letterIcon(b.model) + ' **' + (info ? info.name : (b.model || 'claude')) + '**  \n');
    if (b.model) md.appendMarkdown('`' + b.model + '`  \n');
    if (info) md.appendMarkdown('\n' + info.best + '  \n');
    // Only ever seen on a button someone picked ANYWAY - an unavailable model never
    // reaches the default list - and said rather than swallowed, so "why does this one
    // open a terminal that errors?" has its answer before the click.
    const why = b.model ? usage.modelAvailability(b.label).why : '';
    if (why) md.appendMarkdown('\n$(warning) ' + why + '  \n');
    if (modelVendor(b.model) === 'openai')
        // Said plainly: the lights, the renaming and the armed shutdown all read Claude
        // Code's own files, and a codex tab writes none of them.
        md.appendMarkdown('\n_Click to open a Codex terminal on it_ (`codex -m`) - blue letter, ' +
            'no traffic light and no auto-rename: those read Claude Code\'s session files  \n');
    else
        md.appendMarkdown('\n_Click to open a Claude terminal on it_ - the tab auto-renames to your ' +
            'first prompt, with a traffic light in the title  \n');
    md.appendMarkdown('\n[$(list-selection) Choose models](command:chutdown.pickModels)');
    return md;
}

/// Which models get a button. The setting behind it (`chutdown.claudeButtons`) takes
/// any "label = model" line, but hand-typing model ids into settings.json to swap a
/// button is not something anyone should have to do - this is the same list as a pick.
/// The written order is the CATALOG's, not the click order: the buttons (and the
/// O/F/S/H editor title icons) sit in a fixed order, and a picker that reshuffled
/// them on every edit would move the button the user was aiming at.
async function pickModels() {
    const current = parseClaudeButtons();
    const picked = new Set(current.map((b) => b.model).filter(Boolean));
    // Hand-typed entries outside the catalog stay offered, and stay ticked: a picker
    // that silently dropped a custom model would be a trap, not a convenience.
    const extra = current.filter((b) => b.model && !MODEL_CATALOG.some((m) => m.model === b.model));
    // Two groups under two headings - the Claude models (orange letters, `claude --model`)
    // and the OpenAI ones (blue letters, `codex -m`) - so the second S in the list is
    // never mistaken for the first. A separator row cannot be ticked; it carries no
    // `entry`, which is how it is told apart below.
    const VENDOR_HEAD = { claude: 'Claude Code - orange letters, claude --model',
        openai: 'OpenAI Codex - blue letters, codex -m' };
    const items = [];
    let lastVendor = '';
    for (const m of MODEL_CATALOG) {
        if (m.vendor !== lastVendor) {
            items.push({ label: VENDOR_HEAD[m.vendor] || m.vendor, kind: vscode.QuickPickItemKind.Separator });
            lastVendor = m.vendor;
        }
        // Labelled, never hidden: this is a reading of the account's plan and reported
        // limits, and a picker that silently dropped a model would leave anyone it read
        // wrong with no way back to it. Tick it and the button is yours.
        const av = usage.modelAvailability(m.label);
        items.push({
            label: '$(chutdown-letter-' + m.letter + ') ' + m.label + (av.available ? '' : '  $(warning)'),
            description: m.model,
            detail: (av.why ? av.why + ' ' : '') + m.best,
            entry: m.label + ' = ' + m.model, picked: picked.has(m.model)
        });
    }
    if (extra.length) items.push({ label: 'From your settings', kind: vscode.QuickPickItemKind.Separator });
    for (const b of extra)
        items.push({
            label: b.label, description: b.model,
            detail: 'Custom entry from your settings' +
                (modelVendor(b.model) === 'openai' ? ' - launched with codex -m' : ''),
            entry: b.label + ' = ' + b.model, picked: true
        });

    const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Chutdown: launch buttons',
        placeHolder: 'Pick the models that get a button (each also gets its letter icon in the editor title bar - VS Code draws seven there at most; an eighth sits under that row\'s ... menu)'
    });
    if (!chosen) return;                       // escaped - leave the setting alone
    if (!chosen.length) {
        vscode.window.showWarningMessage('Chutdown: pick at least one model - keeping the current buttons.');
        return;
    }

    // Write into the scope the setting is ALREADY set in, so a workspace-level value
    // is not silently shadowed by a global write the user never sees take effect.
    const inspect = shared.cfg().inspect('claudeButtons') || {};
    const target = inspect.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await shared.cfg().update('claudeButtons', chosen.map((c) => c.entry).filter(Boolean), target);
    // onDidChangeConfiguration rebuilds the buttons - nothing to do here.
}

/// The four editor title icons are STATIC resources - letter-o, letter-f, letter-s,
/// letter-h - and the commands behind them name their model in package.json too. So a
/// slot cannot mean "the Nth button": the moment the button list is not the whole
/// catalog (a plan without Fable, or any picked subset) the letters name models they do
/// not launch. Each slot is a CATALOG POSITION instead - slot 2 is Fable, or slot 2 is
/// not shown - which costs a hand-typed custom model its letter icon but never
/// mislabels one. A pinned snapshot ("claude-haiku-4-5-20251001") still finds its slot,
/// through the same modelInfo match the hover uses.
function slotEntries(entries) {
    return MODEL_CATALOG.map((m) => entries.find((b) => {
        const info = modelInfo(b.model);
        return info && info.model === m.model;
    }) || null);
}

/// The letter a model's TAB wears, from the same static resources the editor title
/// bar uses - so the catalog is the only place the letters are decided, once. A model
/// outside the catalog (a hand-typed id) has no letter and keeps the Chutdown "C" (or,
/// launched with codex, a sparkle - see codexMark). The letter alone does not name the
/// model: Sonnet and Sol are both 's', and the vendor (modelVendor) picks the colour.
function modelLetter(model) {
    const info = modelInfo(model);
    return info ? info.letter : '';
}

/// The same letter again, for the two places that take a $(icon) id instead of an SVG:
/// the status bar button and its hover. A status bar item has no iconPath - its text is
/// plain text and icon ids - so the mark the editor title bar draws from
/// media/letter-*.svg is shipped a second time as glyphs in media/chutdown.ttf
/// (package.json `contributes.icons`, built by media/make-font.js). One glyph per
/// letter, not per model - the two S buttons share it and differ by item colour. A
/// hand-typed model has no letter and keeps the generic sparkle.
function letterIcon(model) {
    const l = modelLetter(model);
    return l ? '$(chutdown-letter-' + l + ')' : '$(sparkle)';
}

/// Editor title bar slot N clicked - launch that catalog model.
function newClaudeSlot(i) {
    const b = slotEntries(parseClaudeButtons())[i];
    if (b) newClaude(b.model);
}

/// The launch buttons: a terminal we created, so its tab is ours to rename later.
/// An OpenAI model opens a CODEX terminal instead (`codex -m <model>`), wearing its
/// blue letter - and is NOT tracked: the lights, the renaming, the bindings and the
/// armed shutdown all read Claude Code's own files (transcripts, pid files, the status
/// file), which a codex tab never writes, so tracking it would only hand the binder a
/// tab with no session to pair it with - and a claude session in the same folder to
/// pair it with by mistake. It is a plain terminal that happens to wear a letter.
function newClaude(model) {
    const cwd = shared.firstRoot();
    const inEditor = shared.cfg().get('openInEditorArea');
    const targetCol = activeViewColumn();
    if (modelVendor(model) === 'openai') {
        const terminal = vscode.window.createTerminal({
            name: 'codex',
            cwd,
            ...codexMark(model),                      // blue S / T / L / M, or a sparkle
            location: claudeLocation()
        });
        terminal.show();
        terminal.sendText('codex' + (model ? ' -m ' + model : ''), true);
        shared.nlog('opened a codex tab in ' + cwd + (model ? ' on ' + model : '') + ' (not tracked)');
        if (inEditor) settleIntoGroup(targetCol);
        return;
    }
    const terminal = vscode.window.createTerminal({
        name: 'claude',
        cwd,
        ...shared.tabMark(modelLetter(model)),   // O / F / S / H, or the "C"
        location: claudeLocation(),
        env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    });
    terminal.show();
    terminal.sendText('claude' + (model ? ' --model ' + model : ''), true);
    trackClaude(terminal, cwd, inEditor, { letter: modelLetter(model) });
    if (inEditor) settleIntoGroup(targetCol);
}

/// A session light with no terminal here can be picked up in a fresh terminal via
/// `claude --resume <id>` - same look and tracking as a new claude tab; the resumeId
/// binds it to the session immediately.
/// A session id comes from a filename under ~/.claude/projects and is typed into a
/// shell by the two `claude --resume` paths below. It is a uuid; treating it as one
/// rather than as arbitrary text costs nothing and means a stray filename can never
/// become part of a command.
function safeId(id) {
    if (/^[A-Za-z0-9-]{4,}$/.test(String(id || ''))) return true;
    shared.nlog('resume: "' + id + '" is not a session id - not resuming');
    return false;
}

/// Is there a transcript for this session on disk? Claude Code writes
/// `~/.claude/projects/<cwd flattened>/<id>.jsonl` on the FIRST message, not at launch:
/// a claude opened and left at its prompt has a session id (its pid file names it, and
/// that is what the bindings saved) but no file, and `claude --resume <id>` on it comes
/// back as `No conversation found with session ID: ...` in a tab that then just sits
/// there. Looked for under the session's own folder first (the name claude derives
/// from the cwd - case-insensitively on the platforms where that matters), then under
/// every project folder, because a session can be resumed from a different folder and
/// the bindings hold the TAB's cwd: one stat per folder, once per revived tab. Only the
/// restart paths ask - a light-click resumes a session the scan read from its file.
function transcriptOnDisk(id, cwd) {
    if (!safeId(id)) return false;
    const fs = require('fs'), path = require('path');
    const file = id + '.jsonl';
    const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
    const own = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
    if (own && isFile(path.join(shared.PROJECTS, own, file))) return true;
    let dirs = [];
    try { dirs = fs.readdirSync(shared.PROJECTS, { withFileTypes: true }); } catch { return false; }
    return dirs.some((d) => d.isDirectory() && isFile(path.join(shared.PROJECTS, d.name, file)));
}

/// The command a revived tab gets - `claude --resume <id>` when the session has a
/// transcript to come back to, a plain `claude` when it never got one (see
/// transcriptOnDisk): the tab held an idle claude, so an idle claude is what comes back,
/// and the rec is left UNBOUND (no sessionId, no resumeId) so bindClaudeTerminals pairs
/// it with the new transcript that appears in its folder like any fresh claude tab.
function reviveCommand(rec, id, cwd) {
    if (transcriptOnDisk(id, cwd)) return 'claude --resume ' + id;
    shared.nlog('revive: ' + String(id).slice(0, 8) + ' has no transcript on disk (a claude that was ' +
        'never spoken to) - opening a fresh claude in its place rather than resuming it');
    rec.sessionId = '';
    rec.resumeId = '';
    return 'claude';
}

function resumeSession(s) {
    if (!safeId(s.id)) return;
    // The folder the session was LAUNCHED in (scan.js: s.home, the first record's
    // cwd), not s.cwd - that is the newest record's, and it follows the session's own
    // Bash tool around. Resuming where the tool last cd'd put "D8A" on the tab (VS
    // Code's ${cwdFolder} description, shown when a terminal's cwd is not the
    // workspace root) and filed the session's work under a project it never belonged to.
    const cwd = s.home || s.cwd || shared.firstRoot();
    const inEditor = shared.cfg().get('openInEditorArea');
    const targetCol = activeViewColumn();
    const terminal = vscode.window.createTerminal({
        name: 'claude',
        cwd,
        // The transcript says which model this session has been running (scan.js reads
        // it off the newest assistant record), so a resumed tab opens wearing the same
        // letter it wore before - and the "C" only when nothing has answered in it yet.
        ...shared.tabMark(modelLetter(s.model)),
        location: claudeLocation(),
        env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
    });
    terminal.show();
    terminal.sendText('claude --resume ' + s.id, true);
    trackClaude(terminal, cwd, inEditor, { resumeId: s.id, letter: modelLetter(s.model) });
    if (inEditor) settleIntoGroup(targetCol);
}

/// Bring a session's terminal to the front IN THE EDITOR AREA. A terminal that was
/// born in the panel gets moved over once (moveToEditor acts on the active terminal).
function revealTerminal(rec) {
    rec.terminal.show();
    if (shared.cfg().get('openInEditorArea') && !rec.inEditor) {
        rec.inEditor = true;
        vscode.commands.executeCommand('workbench.action.terminal.moveToEditor')
            .then(undefined, () => { });
    }
}

/// Click on a traffic light: jump to that session's terminal tab in the editor area.
/// No tab (running outside this window)? Say so - the raw transcript only opens if
/// explicitly asked for.
async function showSession(id) {
    const s = shared.sessions.get(id);
    if (!s) return;
    let rec = shared.claudeRecs.find((r) => r.sessionId === id && vscode.window.terminals.includes(r.terminal));
    // Binding missed (resumed session, several sessions in one folder): exactly ONE
    // live unbound claude terminal in the same folder is almost certainly it.
    if (!rec) {
        const loose = shared.claudeRecs.filter((r) => !r.sessionId &&
            vscode.window.terminals.includes(r.terminal) && shared.normCwd(r.cwd) === shared.normCwd(s.cwd));
        if (loose.length === 1) { rec = loose[0]; rec.sessionId = id; }
    }
    if (rec) {
        // ...unless the user has since typed into that empty shell, or run something in
        // it: it is their tab now, never to be typed over. The binding is dropped and
        // the session gets a fresh terminal, as a session with no tab here would.
        if (rec.revived && userTouched(rec.terminal)) {
            shared.nlog('resume: ' + id.slice(0, 8) + ' - its restored tab is in use, opening a fresh one');
            const i = shared.claudeRecs.indexOf(rec);
            if (i >= 0) shared.claudeRecs.splice(i, 1);
            resumeSession(s);
            return;
        }
        revealTerminal(rec);
        // A tab restored from a quit is an empty shell still wearing the session's
        // name - nothing is running in it, so put the session back INTO that tab
        // instead of opening a second one beside it.
        if (rec.revived && safeId(id)) {
            rec.revived = false;
            rec.resumeId = id;
            rec.terminal.sendText('claude --resume ' + id, true);
        }
        return;
    }
    // USER'S RULING: no popup - a light with no terminal tab here resumes straight
    // away in a fresh terminal. (Yes, if the session is still attached in another
    // window that makes a second claude on the same session - accepted trade-off.)
    resumeSession(s);
}

/// Does this session have a live terminal tab in THIS window?
function hasLocalTerminal(id) {
    return shared.claudeRecs.some((r) => r.sessionId === id && vscode.window.terminals.includes(r.terminal));
}

/// The live terminal a session is running in HERE - the only thing that can be typed into
/// on its behalf (answer.js). Nothing for a session with no tab in this window, and
/// nothing for a shell VS Code revived empty after a quit: it wears the name, but there is
/// no claude behind it to receive a keystroke.
function terminalFor(id) {
    const rec = shared.claudeRecs.find((r) => r.sessionId === id && !r.revived &&
        vscode.window.terminals.includes(r.terminal));
    return rec ? rec.terminal : null;
}

/// The opposite of clicking the light: close the terminal tab this session is running
/// in. Nothing here is destructive - the transcript is on disk, so the light stays one
/// click from a `claude --resume` - and the tab's own close event does the rest of the
/// bookkeeping (claudeTabClosed: binding dropped, session retired to idle, bar
/// re-rendered), exactly as if the tab had been closed by hand.
/// No confirmation, per the same ruling as the click that opens one: a hover link that
/// stops to ask is a hover link nobody uses. A revived shell counts as a tab here even
/// though its light does not - it is still a tab sitting there to be closed.
function closeTab(id) {
    const rec = shared.claudeRecs.find((r) => r.sessionId === id &&
        vscode.window.terminals.includes(r.terminal));
    if (!rec) return;                      // already gone - the next render drops the link
    const s = shared.sessions.get(id);
    shared.nlog('close tab: ' + ((s && s.name) || String(id).slice(0, 8)) + ' (hover)');
    try { rec.terminal.dispose(); } catch { /* already gone */ }
}

/// ...and is that tab an EMPTY SHELL restored from a quit? It wears the session's
/// name but no claude process is behind it, so its light cannot be trusted to the
/// live state - it has to be resolved from the transcript, exactly like a session
/// with no tab here at all.
/// Which sessions had a tab open when this window last saved its bindings - read at
/// startup to decide which lights come back and which start idle.
function savedTabSessions() {
    return hadTabs;
}

/// Has this session EVER had a tab in this window - now, or when the bindings were last
/// saved, or in a tab since closed? Not the same question as hasLocalTerminal, which is
/// only about right now: a session whose tab was closed a minute ago is still one this
/// window opened, while a session running in some OTHER window never was.
function everBoundHere(id) {
    return hadTabs.has(id) || shared.claudeRecs.some((r) => r.sessionId === id);
}

function revivedTab(id) {
    return shared.claudeRecs.some((r) => r.sessionId === id && r.revived &&
        vscode.window.terminals.includes(r.terminal));
}

/// A new transcript appearing in a tracked terminal's folder right after it opened
/// is that terminal's session. With several sessions in the SAME folder the pairing
/// is oldest-terminal <-> oldest-transcript (first-match used to let parallel
/// terminals swap sessions); a --resume id sniffed from the command line binds
/// exactly, and --continue falls back to the folder's most recently written session.
/// Which tab got which session is the one thing the tab title depends on and the one
/// thing nothing used to record - a pairing that never happens looks exactly like a
/// rename that never fires. Every binding says so once, in the output channel.
/// The pid files named the session this tab is running (src/identify.js). A tab we
/// already track just gains the binding; one nothing had ever seen - a claude that was
/// running before this window loaded - is adopted first, so it gets everything an
/// extension-opened tab has: the rename, click-to-reveal, a place in the saved
/// bindings. The session id is also the key into the NAME CACHE, so a tab that came
/// back wearing its creation name goes back to the word it had before.
function claimTab(terminal, rec, ps) {
    const naming = require('./naming');
    // The tab has to still BE there. Nothing between the sweep's candidate list and this
    // call is instant: identify.js awaits terminal.processId, then a process-table
    // listing with a 20s timeout, and a tab closed anywhere in there arrives
    // here dead. For an adopted one (rec === null) that was permanent - trackClaude
    // pushes a record whose only removal path is claudeTabClosed, an event that had
    // already fired and returned early because nothing was tracking the terminal yet. So
    // the corpse kept the session id in claudeRecs, the sweep's `taken` set skipped that
    // id for ever, and a real tab later opened on the same session could never be bound,
    // renamed or revealed for the life of the window. Clears on reload, which is exactly
    // the kind of bug that gets reported as "it just stops working sometimes".
    if (!vscode.window.terminals.includes(terminal)) {
        shared.nlog('identified: tab for session ' + String(ps.sessionId).slice(0, 8) +
            ' closed while we were looking it up - not adopted');
        return;
    }
    if (!rec) {
        trackClaude(terminal, ps.cwd || shared.firstRoot(), false);
        rec = shared.claudeRecs[shared.claudeRecs.length - 1];
    }
    rec.sessionId = ps.sessionId;
    rec.revived = false;              // something IS running in it - never resume over the top
    const prev = naming.cachedName(ps.sessionId);
    const s = shared.sessions.get(ps.sessionId);
    const now = s && s.name ? s.name : '';
    shared.nlog('identified: tab "' + terminal.name + '" (pid ' + ps.pid + ') -> session ' +
        ps.sessionId.slice(0, 8) + (prev ? ' - named "' + prev + '" before' : ' - no name cached') +
        (now && now !== prev ? ', now "' + now + '"' : ''));
    saveBindings();
}

function bindTo(rec, s, how) {
    rec.sessionId = s.id;
    shared.nlog('bound: claude tab in ' + rec.cwd + ' -> ' + (s.name || s.id.slice(0, 8)) + ' (' + how + ')');
}

function bindClaudeTerminals() {
    const bound = new Set(shared.claudeRecs.map((r) => r.sessionId).filter(Boolean));
    for (const rec of shared.claudeRecs) {
        if (rec.sessionId) continue;
        if (rec.resumeId) {
            const hit = [...shared.sessions.values()].find((s) => s.id.startsWith(rec.resumeId));
            if (hit && !bound.has(hit.id)) { bindTo(rec, hit, '--resume'); bound.add(hit.id); }
            continue;
        }
        const here = shared.normCwd(rec.cwd);
        const inFolder = [...shared.sessions.values()]
            .filter((s) => !bound.has(s.id) && shared.normCwd(s.cwd) === here);
        // Fresh transcripts only - anything first seen well before this terminal
        // existed belongs to some other window/terminal...
        const cands = inFolder.filter((s) => s.firstSeen >= rec.created - 10_000)
            .sort((a, b) => a.firstSeen - b.firstSeen);
        if (cands.length) { bindTo(rec, cands[0], 'new transcript'); bound.add(cands[0].id); continue; }
        // ...unless this terminal ran `claude --continue`, which by definition picks
        // up an OLD transcript: the folder's most recently written one.
        if (rec.continueFlag && inFolder.length) {
            const s = inFolder.sort((a, b) => b.lastWriteMs - a.lastWriteMs)[0];
            bindTo(rec, s, '--continue');
            bound.add(s.id);
        }
    }

    // Whatever the evidence above could not pair off - and any tab nothing here has
    // ever seen - is left to the pid files, which answer it exactly.
    identify.kick();
}

/// Tab titles can only be set on the ACTIVE terminal (renameWithArg), so the title -
/// traffic light emoji + name - refreshes whenever its tab is the active one. It is
/// RE-ASSERTED on every poll, not just when it changes: the claude CLI writes its own
/// spinner/status into the terminal title and would otherwise win the tab back right
/// after our one rename. (Terminals we create also get
/// CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 so claude stops competing at the source.)
/// A tab stuck on the name it was created with has no way to say WHY: every bail-out
/// below runs on every poll, so none of them could ever log. This records the reason
/// ONCE, and again only when it changes - the Chutdown output channel then names the
/// missing link (no active terminal / not a tracked tab / not bound to a session yet)
/// instead of staying silent.
let lastRenameWhy = '';
function renameWhy(why) {
    if (why === lastRenameWhy) return;
    lastRenameWhy = why;
    shared.nlog('rename: ' + why);
}

/// A title only Chutdown writes: a traffic light, a space, a session word.
const LIGHT_TITLE = /^(?:🟢|🟠|🟡|🔴|⚪) (.{1,14})$/u;

/// The active tab is NOT one the normal rename path may touch - so if it is wearing a
/// "<light> <name>" title for a session whose tab it is not, one of our renames landed
/// on it (see the mid-flight note in renameActiveClaude): the stamp is stripped by
/// giving the tab its own name back. A batch terminal gets its record's name; anything
/// else gets its creation name, or "claude" when none was recorded - which is what an
/// extension-made claude tab was born as. Without this, a stolen title stuck for ever:
/// every bail-out below just logs, so two tabs sat wearing one session's word.
function repairStolenTitle(active) {
    const m = LIGHT_TITLE.exec(active.name || '');
    if (!m) return false;
    const s = [...shared.sessions.values()].find((x) => x.name === m[1]);
    if (!s) return false;
    if (shared.claudeRecs.some((r) => r.sessionId === s.id && r.terminal === active)) return false;
    let back = '';
    for (const r of shared.termRecs.values()) if (r.terminal === active) back = r.name;
    const born = active.creationOptions && active.creationOptions.name;
    if (!back) back = (typeof born === 'string' && born && !LIGHT_TITLE.test(born)) ? born : 'claude';
    shared.nlog('rename: tab wore "' + active.name + '" - that is ' +
        (s.name || s.id.slice(0, 8)) + '\'s title, not this tab\'s - back to "' + back + '"');
    // The command's promise rather than a bare `true`: a caller that is moving focus
    // around (flickTabs) has to be able to WAIT for the repair, because renameWithArg
    // renames whatever is active when the WORKBENCH runs it - a reveal queued behind
    // this one would otherwise get there first and the repair would land on that tab
    // instead. A promise is truthy, so `if (repairStolenTitle(t)) return;` still reads
    // as "it handled this tab" everywhere else.
    return vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: back })
        .then(() => true, () => true);
}

// ------------------------------------------- a rename made by hand, on the tab
//
// The tab itself can still be renamed the way it always could - double-click the tab,
// right-click > Rename, F2 - and the next poll used to stamp right over whatever was
// typed there. A hand-typed word is a better name than anything scanned or AI-verified,
// so instead of overwriting it the word is ADOPTED: it becomes the session's name
// through exactly the hover's "Edit name" path (uniqueName so two sessions never share
// a word, the name cache so it survives a reload, aiNamed so the namer never
// second-guesses a human) and the traffic light then goes back ON in front of it -
// "🟢 api" - like any other name.

/// A title a PERSON plausibly typed: short and plain. What shells and CLIs write on
/// their own fails this - claude's spinner lines start with a symbol, cwd titles
/// carry / \ or :, exe titles carry slashes and .exe. Up to 30 characters pass so a
/// longer rename is truncated to the 14 the light can carry rather than ignored.
const HAND_TITLE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,29}$/u;

/// The word a hand-rename left on this session's tab - or '' when the worn title is
/// nothing of the sort: our own stamp (current or stale, or landed on the wrong tab -
/// see repairStolenTitle), a shell name, or the CLI's own title writes.
function manualWord(s, worn) {
    const m = LIGHT_TITLE.exec(worn);
    // "<light> <word>" is OUR format - with a live session wearing the word it is one
    // of our stamps, never a rename. Without one, the user typed a new word but kept
    // the light on the front: take the word.
    if (m && [...shared.sessions.values()].some((x) => x.name === m[1])) return '';
    const bare = (m ? m[1] : worn).trim();
    if (bare === s.name) return '';
    if (!HAND_TITLE.test(bare) || SHELL_NAME.test(bare) || /^claude\b/i.test(bare)) return '';
    return bare;
}

/// Every bound claude tab, not just the active one: a rename on a background tab still
/// renames its session and light at once - only the tab TITLE has to wait for the tab
/// to be active again before the light is stamped back onto it.
function adoptManualRenames() {
    for (const rec of shared.claudeRecs) {
        if (!rec.sessionId || !vscode.window.terminals.includes(rec.terminal)) continue;
        const s = shared.sessions.get(rec.sessionId);
        if (!s || !s.name) continue;
        const worn = String(rec.terminal.name || '').trim();
        if (!worn || worn === rec.lastTitle) continue;   // ours, or nothing there
        // The name the terminal was BORN with is not a rename: 'claude' for ours, the
        // profile's name ("dev", "Ubuntu"...) for a user-opened terminal we adopted.
        const born = rec.terminal.creationOptions && rec.terminal.creationOptions.name;
        if (typeof born === 'string' && worn === born.trim()) continue;
        const word = manualWord(s, worn);
        if (!word) continue;
        const unique = shared.uniqueName(s.id, word);
        if (unique === s.name) continue;   // dedupe already settled on this exact word
        shared.nlog('rename: tab renamed by hand to "' + worn + '" - session "' + s.name +
            '" takes it' + (unique === word ? '' : ' as "' + unique + '"'));
        s.name = unique;
        s.aiNamed = true;                  // a human's word outranks the namer's
        require('./naming').cacheName(s.id, unique);
        lights.renderSessions();
    }
}

/// Whatever tab is active NOW, wearing what it ought to wear: its own session's title
/// if it is a bound claude tab, its own name back if one of our stamps landed on it,
/// and nothing but a log line otherwise. Every path returns a promise that settles when
/// the workbench has actually done it (or a bare undefined when there was nothing to
/// do), so a caller that is moving focus around - flickTabs - can WAIT for it: a reveal
/// queued behind an un-awaited rename gets to the workbench first, and the rename then
/// lands on the tab that reveal brought to the front. The poll calls it and ignores
/// the promise, which is what it has always done.
function renameActiveClaude() {
    adoptManualRenames();
    const active = vscode.window.activeTerminal;
    if (!active) return renameWhy('no active terminal');
    const rec = shared.claudeRecs.find((r) => r.terminal === active);
    if (!rec) {
        const fixed = repairStolenTitle(active);
        if (fixed) return fixed;
        return renameWhy('active tab "' + active.name + '" is not a tracked claude terminal ' +
            '(' + shared.claudeRecs.length + ' tracked)');
    }
    if (!rec.sessionId) {
        const fixed = repairStolenTitle(active);
        if (fixed) return fixed;
        return renameWhy('claude tab in ' + rec.cwd + ' is not bound to a session yet');
    }
    const s = shared.sessions.get(rec.sessionId);
    if (!s) {
        const fixed = repairStolenTitle(active);
        if (fixed) return fixed;
        return renameWhy('bound session ' + rec.sessionId.slice(0, 8) + ' is not in the scan');
    }
    if (!s.name) return renameWhy('session ' + rec.sessionId.slice(0, 8) + ' has no name yet');
    const title = lights.lightFor(s).e + ' ' + s.name;
    rec.lastTitle = title;
    renameWhy('-> "' + title + '"');
    return vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: title })
        .then(() => {
            // renameWithArg renames whatever tab is ACTIVE when the command RUNS, not
            // when it was issued. Two prompts sent close together mean tabs changing
            // under the poll, and this title then lands on the neighbour the user just
            // focused - two tabs wearing one session's word, and the victim (unbound,
            // so skipped above) kept it for ever. Focus moved mid-flight: run again
            // for the tab that is active NOW - its own title is rewritten if it is a
            // bound claude tab, and repairStolenTitle strips this stamp if it is not.
            if (vscode.window.activeTerminal !== active) return renameActiveClaude();
        }, (e) => renameWhy('renameWithArg failed: ' + (e && e.message ? e.message : e)));
}

/// A terminal the USER opened where a `claude` command starts gets adopted: it earns
/// the same tab rename + click-to-focus as extension-created claude terminals.
function adoptClaude(e) {
    try {
        touchedTerms.add(e.terminal);     // whatever ran, this tab is in use - see userTouched
        const cmd = (e.execution.commandLine && e.execution.commandLine.value) || '';
        // Anything running in a restored tab means it is NOT an empty shell any more,
        // so a later click must not type a resume command over the top of it.
        const known = shared.claudeRecs.find((r) => r.terminal === e.terminal);
        if (known) { known.revived = false; return; }
        if (!/^\s*claude(\s|$)/i.test(cmd)) return;
        const cwd = e.execution.cwd ? e.execution.cwd.fsPath
            : (e.terminal.shellIntegration && e.terminal.shellIntegration.cwd
                ? e.terminal.shellIntegration.cwd.fsPath : shared.firstRoot());
        const resume = cmd.match(/(?:--resume|-r)(?:\s+|=)([0-9a-fA-F][0-9a-fA-F-]{5,})/);
        const cont = /(?:^|\s)(?:--continue|-c)(?:\s|$)/.test(cmd);
        trackClaude(e.terminal, cwd, false, { resumeId: resume ? resume[1] : '', continueFlag: cont });
    } catch { /* shell integration details unavailable */ }
}

/// Closing a claude tab retires its light too - the session drops into the "idle"
/// dropdown (however young) instead of disappearing; the transcript's current mtime
/// is remembered so only genuinely new activity (a resume) promotes it back.
function claudeTabClosed(terminal) {
    const i = shared.claudeRecs.findIndex((r) => r.terminal === terminal);
    if (i < 0) return;
    const rec = shared.claudeRecs[i];
    shared.claudeRecs.splice(i, 1);
    if (!rec.sessionId) {
        // Never bound to a session, so there is nothing to retire - the startup rule
        // is what catches this one after the next reload.
        shared.nlog('tab closed: unbound claude tab in ' + rec.cwd);
        return;
    }
    const s = shared.sessions.get(rec.sessionId);
    shared.suppressed.set(rec.sessionId, s ? s.parsedMtime : Date.now());
    if (s) s.closedTab = true;
    shared.saveSuppressed();   // ...and stays closed across a window reload
    shared.nlog('tab closed: ' + ((s && s.name) || rec.sessionId.slice(0, 8)) + ' -> idle');
    lights.renderSessions();
}

Object.assign(module.exports, {
    trackClaude, activeViewColumn, claudeLocation, settleIntoGroup,
    claudeButtons, buildClaudeButtons, paintClaudeButtons, buttonLabels,
    newClaude, newClaudeSlot, slotEntries, modelLetter, letterIcon, modelVendor, vendorColor, codexMark,
    TITLE_SLOTS, MODEL_CATALOG,
    pickModels,
    showSession, closeTab, hasLocalTerminal, terminalFor, revivedTab, savedTabSessions, everBoundHere,
    bindClaudeTerminals, renameActiveClaude, sweepTabTitles, refreshTabMarks, pollTabMarks, armTabMarks,
    claimTab, manualWord,
    adoptClaude, claudeTabClosed, saveBindings, restoreBinding, loadPendingBindings, preferredShell,
    reviveClaudeTabs   // exported for the smoke test; the timer in loadPendingBindings runs it
});

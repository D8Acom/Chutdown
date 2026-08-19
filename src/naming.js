// AI tab naming - a cheap headless Claude call (claude -p, haiku by default)
// VERIFIES the scanned-word placeholder after the first turn: it keeps the word if
// it fits the task, otherwise picks a better one, told which names are already taken
// so every tab stays unique. While it thinks, a grey ⚪ entry sits in the status bar.
// It runs OUTSIDE the workspace (cwd = temp dir) on purpose: a claude run inside the
// workspace would earn its own traffic light and hold the armed shutdown hostage.

const os = require('os');
const cp = require('child_process');

const shared = require('./shared');
const platform = require('./platform');
const lights = require('./lights');
const claude = require('./claude');

let namerBusy = false;
let namerDead = false;      // claude CLI missing/broken - stop trying this window
const namerQueue = [];
const namerTries = new Map(); // sessionId -> failed attempts (max 2, then give up)

function cachedName(id) {
    const m = shared.state.extContext.globalState.get('aiNames') || {};
    return m[id];
}

function saveNameCache(id, name) {
    const m = Object.assign({}, shared.state.extContext.globalState.get('aiNames') || {});
    m[id] = name;
    const keys = Object.keys(m);
    if (keys.length > 300)
        for (const k of keys.slice(0, keys.length - 300)) delete m[k];
    shared.state.extContext.globalState.update('aiNames', m);
}

/// Returns whether the session was actually queued - scan.js latches on the ANSWER,
/// not on the attempt. It used to set its `namerQueued` flag before calling and this
/// function could then decline (naming off, the CLI already found missing), leaving a
/// latch set for work that was never queued: turning `aiNames` back on afterwards
/// named nothing for the rest of the window, because every session already looked done.
function queueName(s) {
    if (namerDead || s.aiNamed || !shared.cfg().get('aiNames') || !s.prompt) return false;
    if (namerQueue.includes(s.id)) return true;
    namerQueue.push(s.id);
    runNamer();
    return true;
}

function runNamer() {
    if (namerBusy) return;
    // The latch has to be read HERE too, not only in queueName. Every reason we give up
    // for good - no `claude` on PATH, a spawn that threw, a garbage model id - is found
    // partway through a drain, with a backlog already queued behind it. Guarding only
    // the entry point stopped NEW work while the existing queue went on spawning the
    // process we just proved does not run, twice over per id via the retry below.
    if (namerDead) { namerQueue.length = 0; namerTries.clear(); shared.unpaint(shared.items.namer); return; }
    const namerItem = shared.items.namer;
    const id = namerQueue.shift();
    if (id === undefined) {
        // Nothing left to drain: drop the attempt counts for sessions that no longer
        // exist. Keyed by session id and never cleared, this map grew for the life of
        // the window - a day of work leaves counts for sessions aged out of the scan
        // hours ago. Sessions still known keep their count, so a failed one does not
        // quietly earn two fresh attempts every time the queue happens to empty.
        for (const key of namerTries.keys())
            if (!shared.sessions.has(key)) namerTries.delete(key);
        if (namerItem) shared.unpaint(namerItem);
        return;
    }
    const s = shared.sessions.get(id);
    if (!s || s.aiNamed) { runNamer(); return; }
    // A session the user has already closed is not worth a call at all: a reload can
    // put a dozen of them through here, each a real `claude -p` run of up to a minute,
    // to name tabs that are sitting in the idle dropdown.
    if (s.closedTab) { runNamer(); return; }
    // A session quiet past the stale threshold is not worth a call right now either.
    // The latch is deliberately LEFT SET: scan.js's re-queue condition is exactly the
    // one clearing it restored, so clearing it here put the same id back on the queue
    // on every single scan - shift, skip, recurse, forever, naming nothing. scan.js
    // clears it when the session actually starts working again, which is the only
    // event that makes another attempt worth anything.
    if (shared.quiet(s) >= Math.max(1, shared.cfg().get('staleMinutes')) * 60_000) {
        runNamer();
        return;
    }

    namerBusy = true;
    shared.paint(namerItem, {
        text: '⚪ verifying ' + s.name + '…',
        tooltip: shared.cfg().get('aiNamesModel') + ' is verifying the tab name "' + s.name +
            '" against: ' + (s.prompt || '').slice(0, 150)
    });

    const taken = [...shared.sessions.values()].filter((x) => x.id !== id).map((x) => x.name).filter(Boolean);
    const ask =
        'You verify terminal tab names for coding sessions. This tab is currently named "' +
        s.name + '" - a word auto-picked from the question below. If that word already identifies ' +
        'THIS task well, reply with exactly that word. Otherwise reply with ONE better short ' +
        'lowercase word (letters/digits only, max 14 characters) - specific to the task, not a ' +
        'generic word like "fix" or "update". ' +
        'NEVER use any of these already-taken names: ' + (taken.join(', ') || '(none)') + '. ' +
        'Reply with the word only, nothing else.\n\nThe user asked:\n' + s.prompt.slice(0, 700) +
        (s.lastText ? '\n\nThe assistant\'s first completed answer (what actually got done):\n' +
            s.lastText.slice(0, 700) : '');

    let out = '';
    let err = '';
    let child;
    try {
        // A model id is [a-z0-9.-]; anything else is not one, and this string ends up
        // on a command line. On Windows it has to: `claude` is a .cmd shim, which only
        // resolves through a shell - and there the argument array is flattened back
        // into one line, so a value with a space or an & would break the command or
        // extend it. Everywhere else the args go to execvp untouched, no shell needed.
        const model = String(shared.cfg().get('aiNamesModel') || '').trim();
        if (!/^[A-Za-z0-9._-]+$/.test(model)) {
            namerDead = true; namerBusy = false; shared.unpaint(namerItem);
            shared.nlog('namer: "' + model + '" is not a model id (letters, digits, . _ - only) - naming off');
            return;
        }
        child = cp.spawn('claude', ['-p', '--model', model],
            { shell: platform.id === 'win32', cwd: os.tmpdir(), windowsHide: true });
    } catch (e) {
        namerDead = true; namerBusy = false; shared.unpaint(namerItem);
        shared.nlog('namer: could not spawn claude - ' + e.message);
        return;
    }
    // On Windows the child is cmd.exe (the .cmd shim needs a shell), so `claude` is a
    // GRANDchild and child.kill() does not touch it: a hung namer left a real claude
    // process running - and burning tokens - unattached, one per timeout, reaped by
    // nothing. platform.killPid takes the tree (taskkill /T, or pkill -P then kill).
    const timer = setTimeout(() => {
        shared.nlog('namer: no answer in 60s for "' + s.name + '" - killing it');
        if (child.pid) platform.killPid(child.pid).catch(() => { });
        try { child.kill(); } catch { }
    }, 60_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { namerDead = true; shared.nlog('namer: spawn error - ' + e.message); });
    // A write to a pipe whose reader has gone reports ASYNCHRONOUSLY, as an 'error' on
    // the stream - which the try/catch around the write below cannot catch, and which
    // Node rethrows as an uncaught exception when nothing is listening. `claude` simply
    // not being on PATH was enough: the shell exits at once and the ~1 KB prompt lands
    // on a closed pipe. The close handler already treats that as a failed attempt.
    child.stdin.on('error', (e) => shared.nlog('namer: stdin - ' + e.message));
    child.on('close', (code) => {
        clearTimeout(timer);
        namerBusy = false;
        const s2 = shared.sessions.get(id);
        const applied = !!(s2 && code === 0 && applyAiName(s2, out));
        if (s2 && !applied) {
            const tries = (namerTries.get(id) || 0) + 1;
            namerTries.set(id, tries);
            shared.nlog('namer: attempt ' + tries + ' failed for "' + s2.name + '" (exit ' + code + ') ' +
                String(err || out).trim().slice(0, 300));
            if (tries < 2) namerQueue.push(id);
        }
        runNamer();
    });
    try { child.stdin.write(ask); child.stdin.end(); } catch { }
}

function applyAiName(s, raw) {
    let word = String(raw || '').trim().split(/\s+/)[0] || '';
    word = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 14);
    if (!word) return false;
    // The model is TOLD which names are taken, and still comes back with one now and
    // then (a small model, a long taken-list). Falling straight to "review2" wastes the
    // rest of the question: another distinctive word out of the same prompt names the
    // tab after the task instead of after its neighbour. Required lazily - scan.js
    // requires this module, so a require up top would be a cycle.
    const alts = require('./scan').goodWords(s.prompt).filter((w) => w !== word);
    const unique = shared.uniqueName(s.id, word, alts);
    shared.nlog(unique === s.name ? 'namer: "' + s.name + '" verified'
        : 'namer: "' + s.name + '" -> "' + unique + '"');
    s.name = unique;
    s.aiNamed = true;
    saveNameCache(s.id, unique);
    lights.renderSessions();
    claude.renameActiveClaude();
    return true;
}

/// The latch exists so a broken `claude` is not re-spawned once a second for the life of
/// the window - but it also meant the only way back was a window reload, with the one line
/// that said so buried in the output channel. Toggling the setting is the gesture a user
/// makes when they want it to try again; make it mean that.
function resetNamer() { namerDead = false; }

Object.assign(module.exports, { cachedName, cacheName: saveNameCache, queueName, resetNamer });

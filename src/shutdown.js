// Armable shutdown + the poll. When armed and every session in the workspace has
// finished its turn, a cancellable countdown runs and then powers the machine down.
// The poll (tick) is also the pump that re-scans transcripts and refreshes the status
// bar; it runs every 5 seconds AND on any write under ~/.claude/projects, so the
// trigger lands when the last turn ends rather than up to a poll later.
//
// The toggle has FOUR gears, clicked in a cycle: off -> sound -> notify -> armed -> off.
// "sound" and "notify" are the harmless middle ones: the same all-sessions-finished
// trigger as the armed shutdown, but one only plays a sound and the other only puts a
// popup on screen - nothing is stopped or powered off by either.
//
// Three gears, on a platform with no command for the configured action: the armed one is
// skipped rather than armed-and-apologetic (cycleMode). A gear whose whole purpose is
// powering the machine off has nothing left to be repurposed into that sound and notify
// are not already, so where it cannot act it is not in the cycle at all.
//
// The status bar entry says "Shutdown", not "Chutdown": the extension is Chutdown, but
// that toggle is the machine's power switch and is named after what it does.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const shared = require('./shared');
const platform = require('./platform');
const scan = require('./scan');
const claude = require('./claude');
const lights = require('./lights');
const batch = require('./batch');
const usage = require('./usage');

const MODES = ['off', 'sound', 'notify', 'armed'];
let mode = 'off';
let firing = false;
let announced = false;   // edge trigger: one sound/popup per "everything went quiet" event

// ------------------------------------------------------------------ the sound gear

// The sound ships with the extension: media/chime.wav, so a fresh install chimes
// without depending on what is in C:\Windows\Media or /System/Library/Sounds.
// `soundFile` blank means that bundled chime; a relative path resolves against the
// extension folder (drop your own .wav in media/ and name it); an absolute path is
// used as-is.
const BUNDLED = 'media/chime.wav';

function extDir() {
    const c = shared.state.extContext;
    return c ? c.extensionPath : path.join(__dirname, '..');
}

// A settings value travels: Settings Sync carries `soundFile` between machines, and so does
// a settings.json in a dotfiles repo. A path that is absolute on the OTHER OS is not
// absolute here - path.isAbsolute('C:\\Windows\\Media\\chimes.wav') is FALSE on posix - so
// path.join folded the whole string, backslashes and all, into one nonexistent filename
// inside the extension folder. The chime then quietly became the system sound while
// soundName() (path.basename of the same value) went on naming a Windows wav on the
// toggle's hover, and the picker offered it as a row that could never play.
const FOREIGN_ABS = process.platform === 'win32' ? /^\// : /^[A-Za-z]:[\\/]/;

function resolveSound() {
    const raw = String(shared.cfg().get('soundFile') || '').trim() || BUNDLED;
    if (FOREIGN_ABS.test(raw)) {
        shared.nlog('sound: "' + raw + '" is a path for another operating system - using the bundled chime');
        return path.join(extDir(), BUNDLED);
    }
    return path.isAbsolute(raw) ? raw : path.join(extDir(), raw);
}

function soundName() {
    return path.basename(resolveSound());
}

function quietSuffix() {
    const m = Number(shared.cfg().get('quietMinutes')) || 0;
    return m > 0 ? ' and stayed quiet ' + m + ' min' : '';
}

// A gear that could not deliver has to say so WHERE THE USER IS STANDING, and not only in
// the output channel. The whole premise of the chime and the popup gears is that you are
// not looking at VS Code - that is why you engaged one - so a line in a channel nobody has
// open is indistinguishable from the silent no-op it is describing. A desktop with no audio
// player at all, or with no notifier, has to be told once rather than never.
//
// Once per window per subject, though, and that is the other half of it: these gears fire
// on every finish, and a machine that will never grow a paplay would otherwise put up the
// same warning every time a session ended - which is its own kind of dishonesty about how
// much there is to say.
const saidOnce = new Set();

function sayOnce(key, message) {
    if (saidOnce.has(key)) return;
    saidOnce.add(key);
    vscode.window.showWarningMessage(message);
}

/// What a failed child actually said, rather than the "Command failed: <the whole command>"
/// wrapper cp.exec puts in front of it. The player and notifier chains end in an `echo ...
/// >&2; exit 127` naming the tools they looked for (src/platform), so the last line of the
/// message is the platform's own explanation and is worth showing verbatim.
function whyFailed(e) {
    const lines = String((e && e.message) || '').split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || 'no reason given';
}

// Which player runs the wav is the OS's business (src/platform): PowerShell PlaySync on
// Windows, afplay on macOS, and whichever of paplay, pw-play and aplay is installed on
// Linux and the other POSIX desktops - all chosen because they BLOCK until the sound ends,
// where the obvious call on each returns immediately and cuts the chime off. A missing
// file falls back to that platform's system sound.
function playFile(file) {
    const ok = fs.existsSync(file);
    if (!ok) shared.nlog('sound: ' + file + ' not found - using the system sound');
    const cmd = platform.soundCommand(file, ok);
    // '' is the platform saying it has no player it can name (see platform/darwin.js).
    // Said once, by name, instead of exec'ing an empty string and logging nothing.
    if (!cmd) {
        shared.nlog('sound: no player on ' + platform.name + ' - the chime gear is silent here');
        sayOnce('sound-none', 'Chutdown has no way to play a sound on ' + platform.name +
            ' - the chime gear will stay silent. The notify gear works here.');
        return;
    }
    cp.exec(cmd, platform.execOpts, (e) => {
        if (!e) return;
        shared.nlog('sound: ' + e.message);
        sayOnce('sound-failed', 'Chutdown could not play the finished sound on ' + platform.name +
            ': ' + whyFailed(e));
    });
}

function playSound() {
    playFile(resolveSound());
}

// ------------------------------------------------------------- choosing the sound
//
// `soundFile` is a path in a settings file, and picking a chime by typing a path is the
// wrong way round: you cannot hear a path. So the same setting is also a picker with a
// PLAY button on every row - press it and that sound plays without the list closing, so
// you audition the shortlist and only then pick one. It is reached from the toggle's own
// hover, which is where you are already standing when you decide you don't like the
// chime.
//
// What is offered: the extension's own media/ folder (the bundled ping, the chime that
// shipped before it, and anything you drop in there yourself), then every sound this
// machine already has (platform.systemSoundDir - C:\Windows\Media, /System/Library/
// Sounds, /usr/share/sounds on Linux), then Browse for a file anywhere. Nothing is copied
// or converted: the pick is written to `soundFile` exactly as this list holds it.
//
// .oga and .ogg are in the filter because the stock Linux sound set is Ogg - the
// freedesktop theme under /usr/share/sounds is .oga throughout - and paplay, pw-play and
// ffplay all read it. Without them the "On this machine" group came up EMPTY on an
// ordinary Linux desktop: a picker offering nothing, on a machine full of sounds.
const AUDIO = /\.(wav|aiff?|mp3|m4a|ogg|oga)$/i;

function listDir(dir) {
    try { return fs.readdirSync(dir).filter((f) => AUDIO.test(f)).sort(); }
    catch { return []; }                      // no such folder on this machine
}

/// The rows, without any UI attached - which is what makes them testable. `value` is
/// what goes into `soundFile`: '' for the bundled default, a media-relative path for
/// anything shipped with the extension, an absolute path for the rest.
function soundChoices() {
    const rows = [];
    const current = String(shared.cfg().get('soundFile') || '').trim();

    rows.push({ group: 'Bundled', label: path.basename(BUNDLED, '.wav'), value: '',
        detail: 'The default: a low wooden knock, half a second (media/make-chime.js generates it)' });
    for (const f of listDir(path.join(extDir(), 'media'))) {
        const rel = 'media/' + f;
        if (rel === BUNDLED) continue;                       // already the row above
        rows.push({ group: 'Bundled', label: path.basename(f, path.extname(f)), value: rel, detail: rel });
    }

    const sysDir = platform.systemSoundDir;
    for (const f of listDir(sysDir))
        rows.push({ group: 'On this machine', label: path.basename(f, path.extname(f)),
            value: path.join(sysDir, f), detail: path.join(sysDir, f) });

    // A path already in the setting that is none of the above - typed by hand, or picked
    // through Browse in an earlier visit - is offered too, or choosing anything else
    // would be the only way to see what you already had.
    if (current && !rows.some((r) => r.value.toLowerCase() === current.toLowerCase()))
        rows.unshift({ group: 'Bundled', label: path.basename(current, path.extname(current)),
            value: current, detail: 'Your current sound: ' + current });
    return rows;
}

async function pickSound() {
    const rows = soundChoices();
    const current = String(shared.cfg().get('soundFile') || '').trim();
    const BROWSE = { browse: true };
    const play = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Play it (the list stays open)' };

    const items = [];
    let group = null;
    for (const r of rows) {
        if (r.group !== group) { group = r.group; items.push({ label: group, kind: vscode.QuickPickItemKind.Separator }); }
        items.push({
            label: (r.value.toLowerCase() === current.toLowerCase() ? '$(check) ' : '$(unmute) ') + r.label,
            detail: r.detail, row: r, buttons: [play]
        });
    }
    items.push({ label: 'Other', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: '$(folder-opened) Browse for a sound file...', row: BROWSE,
        detail: 'Any .wav on this machine - it is referenced where it is, not copied' });

    const qp = vscode.window.createQuickPick();
    qp.title = 'Chutdown: the sound when every session finishes';
    qp.placeholder = 'Press $(play) to hear one, Enter to keep it';
    qp.items = items;
    qp.matchOnDetail = true;
    // Preview WITHOUT choosing: the button plays and leaves the list up. Accepting is
    // the only thing that writes the setting.
    qp.onDidTriggerItemButton((e) => {
        const r = e.item.row;
        if (r && !r.browse) playFile(r.value ? absolute(r.value) : resolveBundled());
    });

    const chosen = await new Promise((done) => {
        qp.onDidAccept(() => { done(qp.selectedItems[0]); qp.hide(); });
        qp.onDidHide(() => { done(undefined); qp.dispose(); });
        qp.show();
    });
    if (!chosen || !chosen.row) return;                      // escaped, or a separator

    let value = chosen.row.value;
    if (chosen.row.browse) {
        const picked = await vscode.window.showOpenDialog({
            title: 'Chutdown: pick a sound file',
            canSelectMany: false, openLabel: 'Use this sound',
            filters: { Sounds: ['wav', 'aiff', 'aif', 'mp3', 'm4a', 'ogg', 'oga'] }
        });
        if (!picked || !picked.length) return;
        value = picked[0].fsPath;
    }

    // Written into the scope the setting is ALREADY set in, so a workspace-level value
    // is not silently shadowed by a global write the user never sees take effect.
    const inspect = shared.cfg().inspect('soundFile') || {};
    const target = inspect.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await shared.cfg().update('soundFile', value, target);
    updateToggle();                            // the hover names the sound
    playSound();                               // ...and you hear what you just chose
}

function absolute(v) {
    return path.isAbsolute(v) ? v : path.join(extDir(), v);
}

function resolveBundled() {
    return path.join(extDir(), BUNDLED);
}

// One chime per finish, however many VS Code windows are open on the workspace: they
// all watch the same transcripts, so they would all sound their own - and the notify
// gear would put up one popup per window. The claim is an exclusive file create ('wx'
// is atomic), keyed by workspace root AND gear - whoever wins it plays, anyone else
// arriving within CHIME_GAP stays quiet. It also backstops the edge trigger: two
// chimes (or popups) for one finish cannot get through here.
const CHIME_GAP = 5000;

function announceStamp(kind) {
    const key = crypto.createHash('sha1').update(shared.firstRoot().toLowerCase()).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), 'chutdown-' + kind + '-' + key);
}

function claimAnnounce(kind) {
    const stamp = announceStamp(kind);
    try {
        if (Date.now() - fs.statSync(stamp).mtimeMs < CHIME_GAP) return false;
        fs.unlinkSync(stamp);
    } catch { /* no stamp yet, or another window just took it */ }
    try { fs.closeSync(fs.openSync(stamp, 'wx')); return true; }
    catch { return false; }                       // lost the race - the other window chimes
}

function chime() {
    if (claimAnnounce('chime')) playSound();
    else shared.nlog('chime: another window just played it');
}

// ----------------------------------------------------------------- the notify gear
//
// A VS Code notification is no use for the thing this gear is for - you are not looking
// at VS Code, that is WHY you engaged it - so the popup is an OS one (src/platform): a
// WScript.Shell Popup on Windows, an osascript dialog on macOS. Both come up ON TOP of
// whatever is focused and wait there to be clicked, so a finish that lands while you are
// in another app - or out of the room - is still on screen when you look. `notifyStyle`
// switches either to that platform's quiet system toast instead.
//
// The editor notification is shown as WELL, not instead: it is the one still readable
// ten minutes later, in the notification centre.

function notifyTitle() {
    const root = shared.firstRoot();
    // Named, because the popup is OS-level: with three windows open on three projects
    // there is otherwise nothing on it to say which one has finished.
    return 'Chutdown' + (root ? ' - ' + path.basename(root) : '');
}

function notifyText() {
    const n = status().watched.length;
    return 'All ' + n + ' Claude session' + (n === 1 ? '' : 's') + ' in this workspace finished.';
}

/// Fire and forget: the dialog style BLOCKS until it is clicked, so this child can live
/// for hours - that is the point of it - and nothing here waits on the callback.
function notifyNow() {
    const style = String(shared.cfg().get('notifyStyle') || 'dialog');
    const cmd = platform.notifyCommand(notifyTitle(), notifyText(), style);
    // The defensive path, kept: every supported platform names a notifier now, so '' means
    // one we have never heard of. It used to be a bare return, which is the shape the
    // platform rule forbids outright - the gear was engaged, the trigger was met, and
    // absolutely nothing happened. The message it would have carried is delivered here
    // instead, saying plainly that this is the editor's notification and not the desktop
    // popup that was asked for.
    if (!cmd) {
        shared.nlog('notify: no popup command on ' + platform.name);
        vscode.window.showWarningMessage(notifyText() + ' (no desktop popup on ' + platform.name +
            ' - this is the editor notification only)');
        return;
    }
    shared.nlog('notify: ' + style);
    cp.exec(cmd, platform.execOpts, (e) => {
        if (!e) return;
        shared.nlog('notify: ' + e.message);
        sayOnce('notify-failed', 'Chutdown could not put the finished popup on the desktop on ' +
            platform.name + ': ' + whyFailed(e) + ' - the editor notification is all there was.');
    });
}

function notifyDone() {
    if (!claimAnnounce('notify')) { shared.nlog('notify: another window just popped it'); return; }
    notifyNow();
    vscode.window.showInformationMessage(notifyText());
}

// ------------------------------------------------------- "is everything finished?"
//
// The answer comes from the transcripts, not from a stopwatch: a session is finished
// when its newest main-thread record says the TURN ENDED (scan.parseTail reads the
// API's own stop_reason) and nothing has been written for it since - including by
// background agents, whose sidecar writes push lastWriteMs forward (scan.js).
// `settleSeconds` is only an anti-flicker margin for the case where a finished turn
// is immediately continued by a queued message or a hook; it is not a guess about
// whether Claude is done, which is why it is seconds and not minutes.
//
// Closed-tab sessions are retired from the watch. A session still WORKING blocks both
// gears however long it takes - a 20-minute build writes nothing, and going quiet is
// not the same as being finished - but only while something could actually BE running
// it: a tab here, or a transcript another window is still writing (lights.js). One
// left 'working' by a window that went away is dead, not busy.

function settleMs() {
    const n = Number(shared.cfg().get('settleSeconds'));
    return Math.max(0, isFinite(n) ? n : 3) * 1000;
}

/// How long this session has been finished. Measured from when the TURN ENDED
/// (scan.js sets awaitingSince), not from the last write: a finished transcript keeps
/// being touched by bookkeeping records for minutes afterwards.
function finishedMs(s) {
    return Date.now() - (s.awaitingSince || s.lastWriteMs);
}

function isFinished(s, settle) {
    // Background agents/workflows still working keep the session busy OUTRIGHT.
    // scan.js reads that from each agent transcript's own stop_reason, the same rule
    // as the main thread - never from sidecar mtimes, which go quiet for a minute at
    // a time mid-tool-call and once let the chime fire under six mid-turn agents.
    if (s.background) return false;
    if (s.state === 'awaiting') return finishedMs(s) >= settle;
    // We could not read far enough back to tell (scan.js: a single record bigger than
    // the retry window - a pasted image, a screenshot-returning tool). NOT finished:
    // the one thing worse than a light that will not go red is a machine that powers
    // off because it could not see what the session was doing.
    if (s.state === 'unparsed') return false;
    // A transcript with no turn in it at all - a claude tab that was opened, maybe had
    // /model run in it, and never prompted. There is nothing to wait for, and a tab
    // sitting at an empty prompt must not hold the gears shut. (status() drops these
    // from `watched` entirely, so this is only reached by a caller asking about one
    // directly - it is still "not something to wait for".)
    if (s.state === 'unknown') return true;
    // 'working' is only where the transcript STOPPED. If no tab here is running it and
    // nothing is writing it any more, the session died mid-turn (its window went away)
    // and the lights already draw it 🟠 interrupted - so it must not go on holding the
    // gears back for ever, which is the one way "everything is finished" used to stay
    // false with every light in the bar red.
    //
    // But the LIGHT's threshold for that is orphanMinutes (default 2), and two minutes
    // of silence is not death mid-turn: Claude Code writes the tool_use record and then
    // nothing until the tool returns, so any build or test run longer than that looks
    // identical to a dead window - including a session being run right now from another
    // VS Code window or a plain terminal, which this window cannot see a tab for. So
    // the GEARS use the same dead-threshold the background agents already get (15 min,
    // scan.AGENT_DEAD_MS, sized for a maxed-out 10-minute tool call); orphanMinutes
    // goes on deciding only how the light is drawn.
    return !lights.couldStillBeRunning(s, scan.AGENT_DEAD_MS);
}

/// { watched, busy } - busy is what is still holding the trigger back.
///
/// A never-prompted tab ('unknown': a transcript with no turn in it) is not watched at
/// all, rather than watched-and-finished. The difference matters because allFinished()
/// needs SOMETHING to have finished: counting it as finished made a workspace whose
/// only claude tab had never been typed into read as "everything is done", so arming
/// the toggle beside a fresh empty tab started the countdown immediately - on evidence
/// that no work had ever happened, not that it had ended.
function status() {
    const watched = [...shared.sessions.values()].filter((s) => !s.closedTab && s.state !== 'unknown');
    const settle = settleMs();
    return {
        watched,
        busy: watched.filter((s) => !isFinished(s, settle)),
        // Sessions sitting on a QUESTION - the CLI's own "waiting" status (a pending
        // AskUserQuestion, a plan approval, a permission prompt), or a reply that ended
        // in "?". The turn has genuinely ended, so they are "finished" for the sound and
        // the popup: that is exactly the moment worth telling you about. They are NOT
        // finished for the power action, though - see asking().
        asking: watched.filter((s) => (s.waiting || s.question) && s.state === 'awaiting')
    };
}

/// Work that is waiting on YOU, and still worth waiting for. The sound and popup gears
/// fire over these - being asked something is exactly the moment to come back, and the
/// chime is how you find out. The ARMED gear holds instead: a question on screen is
/// unfinished work whose answer would go down with the machine.
///
/// It does not hold FOREVER, though. A question nobody is going to answer - you went to
/// bed - would otherwise keep the machine on all night, which is the thing the armed gear
/// exists to prevent. So the hold lasts `questionMinutes` from the moment the question
/// went up (default 2), after which it is treated as abandoned and stops counting.
function askingNow() {
    const holdMs = Math.max(0, Number(shared.cfg().get('questionMinutes')) || 0) * 60_000;
    const now = Date.now();
    return status().asking.filter((s) => {
        if (!holdMs) return false;                       // 0 = questions never hold it up
        const since = s.waitingSince || s.awaitingSince || s.lastWriteMs || now;
        return now - since < holdMs;
    });
}

function allFinished() {
    const { watched, busy } = status();
    return watched.length > 0 && busy.length === 0;      // nothing to wait for yet = not "done"
}

// ------------------------------------------------- every window, not just this one
//
// A session light only ever covers the sessions of ITS workspace - deliberately, and the
// sound and popup gears are right to work that way: you want to hear that THIS project
// finished. The power action is not like that. There is one machine, and it does not
// matter which window's work is still running when it goes off: an armed window used to
// wait for its own sessions, see them all go red, and power the machine down over the top
// of another window that was mid-turn on a different project.
//
// So each window leaves a heartbeat in the temp dir - who it is, what it is waiting on -
// rewritten on every poll, and the ARMED gear waits for all of them. A window is live
// while its heartbeat is fresh; one that crashed or was killed stops counting a few polls
// later rather than blocking the shutdown for ever. No window is in charge, nothing has
// to be configured, and a window with the gear OFF still blocks the shutdown, because a
// busy session is busy whether or not that window cares about powering down.
const PEERS = path.join(os.tmpdir(), 'chutdown-windows');
const PEER_ID = crypto.randomBytes(6).toString('hex');
const PEER_FRESH_MS = 20_000;         // 4 polls: a live window has written within this
const PEER_SWEEP_MS = 6 * 3_600_000;  // ...and a file this old is from a window long gone

function peerFile() {
    return path.join(PEERS, PEER_ID + '.json');
}

/// This window's line in the shared ledger, written every poll.
function writePeer() {
    const { watched, busy } = status();
    // The TIMED-OUT list, not the raw one: `questionMinutes` decides how long a question
    // holds the power action, and a window advertising every question it can see - with
    // no expiry - reimposed an infinite hold on everyone else. Two armed windows watching
    // the same session then held each OTHER open for as long as the question was up, each
    // one correctly ignoring its own expired question and dutifully waiting on the other's
    // copy of it. What is published has to be what actually holds.
    const asking = askingNow();
    const names = (list) => list.slice(0, 6).map((s) => s.name || s.id.slice(0, 8));
    try {
        fs.mkdirSync(PEERS, { recursive: true });
        // Written to a sibling and RENAMED over, because a plain writeFileSync opens
        // with O_TRUNC and the file is observably empty until the write lands. readPeers
        // drops whatever will not parse, and a dropped peer is absent rather than
        // unknown - so a torn read made a busy window look like no window at all, and
        // everyoneFinished() returned true. That is a fail-open on the one check that
        // stops this window powering the machine off over another window's work, and it
        // is read once a second for the whole countdown and again just before the power
        // command. rename is atomic within a directory on both supported platforms.
        const tmp = peerFile() + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            at: Date.now(),
            root: path.basename(shared.firstRoot() || '') || 'workspace',
            // The gear, and WHEN it was last decided: this is how the toggle travels
            // between windows (see below). The GEAR, not the live toggle - they part
            // company when this window is in a gear that does not travel, and a record
            // saying `sound` would be skipped by everyone else and quietly leave an
            // armed peer armed. A record with no `gearAt` never decided anything, so
            // it cannot move anyone else's toggle.
            gear: gearMode,
            gearAt,
            watched: watched.length,
            // Names, so the armed window can SAY what it is waiting for rather than
            // just sitting there looking stuck. `asking` is separate from `busy`
            // because it holds the power action back for a different reason: not
            // "still running" but "waiting for you".
            busy: names(busy),
            asking: names(asking)
        }));
        fs.renameSync(tmp, peerFile());
    } catch (e) { shared.nlog('peers: ' + e.message); }
}

function dropPeer() {
    try { fs.unlinkSync(peerFile()); } catch { /* already gone */ }
}

/// Every OTHER live window's line. Long-dead files are swept as we go, so a machine that
/// has opened a thousand windows does not accumulate a thousand files.
function readPeers() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(PEERS); } catch { return out; }
    const now = Date.now();
    for (const f of files) {
        if (f.endsWith('.json.tmp')) continue;          // a peer mid-write; its real file is next to it
        if (!f.endsWith('.json') || f === PEER_ID + '.json') continue;
        const p = path.join(PEERS, f);
        let rec;
        try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch {
            // Belt and braces behind the atomic write above: a file we cannot read is a
            // window we know nothing about, and "nothing known" must not read as "not
            // busy". If it is younger than the freshness window, count it as a busy peer
            // with no name; if it is old, it is a dead window's litter and is skipped.
            let fresh = false;
            try { fresh = now - fs.statSync(p).mtimeMs <= PEER_FRESH_MS; } catch { }
            if (fresh) out.push({ at: now, root: 'unreadable', watched: 1, busy: ['(unreadable window record)'], asking: [] });
            continue;
        }
        const age = now - (rec.at || 0);
        if (age > PEER_SWEEP_MS) { try { fs.unlinkSync(p); } catch { } continue; }
        if (age <= PEER_FRESH_MS) out.push(rec);
    }
    return out;
}

/// What the other windows are still holding the power action for - work in flight, or a
/// question waiting on the user. [] when they are all done, or this is the only window.
function peersBusy() {
    return readPeers().filter((p) => (p.busy && p.busy.length) || (p.asking && p.asking.length));
}

/// The ARMED trigger, and the whole of it: this workspace has finished, nothing here is
/// waiting on an answer, and every other live window can say the same.
///
/// The sound and popup gears keep using allFinished() - they are about this project going
/// quiet, and a question is a fine reason to chime.
function everyoneFinished() {
    // The sidecar walk goes LAST, behind every check that can be answered from memory:
    // it is the only one here that touches the filesystem, and the three in front of it
    // reject most calls outright.
    return everyoneFinishedCheap() && !backgroundResumed();
}

/// The same verdict, from what is already in memory - no sidecar walk. Everything here
/// is an in-memory filter over the scanned sessions, plus the peer ledger's handful of
/// small reads, so it is cheap enough to ask once a second.
///
/// The countdown does exactly that, which is why this exists: backgroundResumed() walks
/// two directory trees PER WATCHED SESSION, and running that at 1 Hz for two minutes on
/// the extension host thread is the very cost src/scan.js was rewritten to stop paying.
/// Nothing is given up by leaving it out of the loop - an agent that resumes mid-count
/// is caught by the full check, which runs once, immediately before anything
/// irreversible happens.
function everyoneFinishedCheap() {
    if (!allFinished()) return false;
    if (askingNow().length) return false;
    return peersBusy().length === 0;
}

/// The sidecar walk stops for a session that has been silent longer than an agent can
/// be, and only a MAIN transcript write starts it again - so an agent that went quiet
/// through a long tool call and then resumed writing its own transcript reads as
/// finished until its completion notification lands. Cheap to be wrong about that
/// anywhere else; here it powers the machine off mid-agent. So the trigger re-walks
/// for real before it agrees, which costs one walk at the one moment it matters.
function backgroundResumed() {
    try { return scan.recheckBackground(status().watched); } catch { return false; }
}

// ------------------------------------------------------------ the gear, in every window
//
// The waiting above is half the job. The other half is that the GEAR is one decision
// about one machine: set it in the window you happen to be in, and every other window
// shows the same - because the machine really is going to power off, and a window whose
// toggle says "off" while that is true is lying to you. Turning it off anywhere turns it
// off everywhere, for the same reason. Only armed <-> off travels: `sound` and `notify`
// are per-project by design - you engage the chime in the window whose work you are
// waiting on - and syncing those would mean every window chiming for a project it does
// not care about.
//
// It travels in the heartbeat above - the ledger every window already rewrites each poll
// and every window already reads - rather than in a file of its own. That is what makes
// it safe: a gear is only ever adopted from a window that is ALIVE NOW, so a marker left
// in the temp dir by a machine that armed itself yesterday is stale by definition and
// cannot arm anything, and a window that reloads picks the current gear back up instead
// of silently coming back OFF while another window counts down.
//
// `gearAt` is when this window's gear was last DELIBERATELY changed - clicked, or adopted
// from a window where it was clicked - and the newest one across the live windows wins.
// It is not touched by a gear that merely got re-stated (a countdown that stood down and
// left the gear exactly as it was, say): re-stamping an unchanged gear would republish it
// as a fresh decision, and every window that had legitimately started OFF since would
// adopt it. That is an arming nobody asked for, which is the one thing this must not do.
let gearAt = 0;         // 0 = this window has never changed the gear, so anything beats it
let gearMode = mode;    // the gear as last published or adopted
const TRAVELS = ['off', 'armed'];   // the gears that are a decision about the MACHINE

function writeGear() {
    if (!TRAVELS.includes(mode)) return;   // sound/notify stay in the window they were set in
    if (mode === gearMode) return;   // nothing was decided: do not republish
    gearMode = mode;
    gearAt = Date.now();
    writePeer();   // the ledger carries the gear, so publish now rather than at the next poll
}

/// Adopt the newest gear any LIVE window has decided on. Called from the poll, so it
/// lands within a tick of the click that made it.
function syncGear() {
    let best = null;
    for (const p of readPeers()) {
        const at = Number(p.gearAt) || 0;
        if (!at || !TRAVELS.includes(p.gear)) continue;
        if (!best || at > best.at) best = { at, mode: p.gear };
    }
    if (!best || !(best.at > gearAt)) return;
    gearAt = best.at;
    gearMode = best.mode;
    // A gear that travelled here from a window on the SAME machine still has to be one this
    // window can honour, and "the same machine" is not the same thing as "the same
    // capability": the peer could be a remote window, or this one could have an `action`
    // set that its OS has no command for. Arming on a peer's say-so would produce exactly
    // the state the click already refuses - an armed status bar item promising a power
    // action that does not exist here - only with nobody at this keyboard to be told.
    //
    // The STAMP is consumed either way, deliberately. Leaving gearAt behind would make this
    // window re-decide the same peer gear on every poll (a log line every five seconds),
    // and taking it means the ledger this window republishes agrees with the one it read
    // rather than contradicting it. What is not done is writing a gear of our own: `mode`
    // is left exactly where the user put it.
    if (best.mode === 'armed' && !powerAvailable(shared.cfg().get('action'))) {
        shared.nlog('gear: another window armed the shutdown, but there is no "' +
            shared.cfg().get('action') + '" power action on ' + platform.name +
            ' - this window stays where it is');
        return;
    }
    if (mode === best.mode) return;
    // A countdown already running is left alone: it re-checks the trigger every second
    // and has its own Cancel, and yanking the gear out from under it mid-count would be
    // a second, invisible way to cancel.
    if (firing && best.mode === 'armed') return;
    mode = best.mode;
    announced = allFinished();
    updateToggle();
    shared.nlog('gear: another window turned the shutdown ' + (mode === 'armed' ? 'ARMED' : 'off'));
}

/// "detf (2 running), card (1 waiting on you)" - for the hover, and for the notification
/// that has to explain why the countdown did not start.
function peerBusyList() {
    return peersBusy().map((p) => {
        const parts = [];
        if (p.busy && p.busy.length) parts.push(p.busy.length + ' running');
        if (p.asking && p.asking.length) parts.push(p.asking.length + ' waiting on you');
        return p.root + ' (' + parts.join(', ') + ')';
    }).join(', ');
}

/// Escaped: these are session NAMES - scanned from a first prompt, or written by the AI
/// namer - and the toggle's hover is a trusted MarkdownString now that it carries the
/// test links, where an unescaped name could become a link of its own (shared.js).
function busyNames(busy) {
    const names = busy.slice(0, 4).map((s) => shared.mdText(s.name || s.id.slice(0, 8)));
    return names.join(', ') + (busy.length > names.length ? ', +' + (busy.length - names.length) + ' more' : '');
}

/// The same list for a NOTIFICATION, which is plain text: escaping it there would show
/// the backslashes, so the two callers are deliberately separate.
function busyList() {
    const busy = status().busy;
    if (!busy.length) return '';
    const names = busy.slice(0, 4).map((s) => s.name || s.id.slice(0, 8));
    return ' Still running: ' + names.join(', ') +
        (busy.length > names.length ? ', +' + (busy.length - names.length) : '') + '.';
}

/// The anti-flicker margin, mentioned only when it is actually set to something - a
/// hover that explains a 0-second wait is explaining nothing.
function settleNote() {
    const s = Math.round(settleMs() / 1000);
    return s > 0 ? ', and nothing has been written for ' + s + 's' : '';
}

// ------------------------------------------------------------------ the toggle

/// The commands the toggle's hover may run - the same narrow allow-list every other
/// hover in this extension uses (see shared.js): trying one of these three costs
/// nothing, which is exactly why they are a click away from the gear rather than three
/// palette searches away.
const HOVER_COMMANDS = ['chutdown.testSound', 'chutdown.testNotify', 'chutdown.pickSound'];

/// The hover answers the question the gear actually raises - "what is going to happen,
/// and when?" - in the order you ask it: what this gear DOES, what has to be true first,
/// where that stands right now, and what the next click gets you. The sound and popup
/// links sit at the bottom as a footer, because they are a side errand: nobody hovers a
/// power switch to audition a wav.
function toggleHover(what, click) {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: HOVER_COMMANDS };
    md.supportThemeIcons = true;
    md.appendMarkdown(what + '  \n\n');
    md.appendMarkdown('**Fires when** every Claude session in this workspace has finished its turn - ' +
        'read from each transcript\'s own stop reason, never guessed from silence. A session waiting on ' +
        'a question counts as finished; one mid-tool-call does not' + settleNote() + '.  \n\n');
    md.appendMarkdown(watchLine() + '  \n\n');
    md.appendMarkdown('_Click for ' + click + '._  \n');
    md.appendMarkdown('\n[$(play) Test sound](command:chutdown.testSound)' +
        ' · [$(bell-dot) Test popup](command:chutdown.testNotify)' +
        ' · [$(unmute) Change sound](command:chutdown.pickSound)');
    return md;
}

/// Where the trigger stands this second - the line that turns the hover from a
/// description into a status. Naming what is still running is the whole point: "why has
/// it not fired yet" is the question a waiting gear provokes.
function watchLine() {
    const { watched, busy, asking: waiting } = status();
    // Only the ARMED gear waits on other windows and on questions, so only it reports
    // them - the sound and popup gears are about this project going quiet, and a session
    // asking you something is a fine reason to chime.
    const armed = mode === 'armed';
    const elsewhere = armed ? shared.mdText(peerBusyList()) : '';
    let extra = elsewhere ? '  \n$(window) **Another window:** ' + elsewhere +
        ' - the shutdown waits for those too.' : '';
    if (armed && waiting.length)
        extra = '  \n$(question) **Waiting on your answer:** ' + busyNames(waiting) +
            ' - the shutdown will not run over a question.' + extra;
    if (!watched.length)
        return '$(circle-slash) **Nothing to watch yet** - no session in this workspace has taken a turn.' + extra;
    if (busy.length) return '$(sync~spin) **Still working:** ' + busyNames(busy) + '.' + extra;
    return '$(check) **All ' + watched.length + ' session' + (watched.length === 1 ? '' : 's') +
        ' here have finished.**' + extra;
}

/// Painted, not assigned: this runs on every 5s poll, and writing an unchanged tooltip
/// still re-renders the item - which closes the hover the moment you settle on it
/// (shared.paint). The hover's own text is kept churn-free for the same reason: no
/// second-by-second countdown in it, only what changes when something happens.
function updateToggle() {
    const action = shared.cfg().get('action');
    const n = Number(shared.cfg().get('countdownSeconds'));
    const secs = Math.max(5, isFinite(n) ? n : 120);
    let text, background, what, click;

    if (mode === 'armed' && !powerAvailable(action)) {
        // The click is where this is normally refused (cycleMode), so reaching here means
        // the gear was armed while the action was one this OS could run and the `action`
        // setting has been changed since - to a shutdown, restart or log out with no
        // command behind it here. A settings edit must not be able to put the ARMED claim
        // back on screen behind the user's back, so the paint asks the platform too rather
        // than trusting that the click already did.
        //
        // errorBackground, not the armed gear's warningBackground: this is not the armed
        // state wearing a caveat, it is the item saying it cannot do the thing it is named
        // after. Nothing else about the gear changes - it is still armed, it still watches,
        // and fire() below refuses at the front rather than counting down to nothing.
        text = '$(warning) Status: no ' + action + ' here';
        background = new vscode.ThemeColor('statusBarItem.errorBackground');
        click = 'off';
        what = '$(warning) **There is no "' + action + '" power action on ' + platform.name + '.**  \n' +
            'The gear is armed and still watching, but nothing here can carry the action out - so when ' +
            'everything finishes it will say so and stop, without stopping your dev servers and without ' +
            'powering anything off.  \n' +
            'Set `chutdown.action` to **test** to walk the whole sequence through harmlessly, or use the ' +
            '**sound** or **notify** gear, which work on every platform.';
    } else if (mode === 'armed') {
        // The gear is named after WHAT IT WILL DO, not after the state it is in: with the
        // item now reading "Status:", a bare "ARMED" says a thing is loaded without saying
        // which thing, and `action` is already the four answers (shutdown / restart /
        // logoff / test). "Status: test" is then honest where "Status: shutdown" would be
        // a lie about a gear that only shows a message.
        text = '$(power) Status: ' + action;
        background = new vscode.ThemeColor('statusBarItem.warningBackground');
        click = 'off';
        what = '$(power) **Armed - this machine will ' + action + '.**  \n' +
            'Waits for **every VS Code window**, not just this one: there is one machine, and another ' +
            'window mid-turn on a different project is as good a reason not to power it off as one of ' +
            'yours.  \n' +
            'When the trigger below is met' + quietSuffix() + ', a **' + secs + 's countdown** appears with ' +
            'a Cancel button. It is not a commitment: the trigger is re-read every second, and once more ' +
            'immediately before anything irreversible - so a session that starts working again (a hook, a ' +
            'queued message, a background agent, another window) calls the whole thing off and leaves the ' +
            'gear armed for next time. Clicking this toggle mid-countdown stops it too.  \n' +
            'Then the `.terminals` batch gets Ctrl+C - so dev servers exit rather than being killed ' +
            'mid-write - and ' + (action === 'test'
                ? '**test** only shows a message. Nothing is powered off.'
                : 'the machine runs **' + action + '**.') + forceNote(action);
    } else if (mode === 'sound') {
        text = '$(bell) Status: sound';
        click = 'a desktop popup instead';
        what = '$(bell) **Sound only - nothing is stopped or powered off.**  \n' +
            'Plays ' + shared.mdText(soundName()) + ' once when the trigger below is met, then stays quiet ' +
            'until some session actually starts working again.';
    } else if (mode === 'notify') {
        text = '$(bell-dot) Status: notify';
        // The next click is only "to arm" where there is something to arm. Where the armed
        // gear is skipped (see cycleMode) the cycle is three gears long, and a hover that
        // offered a fourth would be promising the click something it is not going to get.
        click = powerAvailable(action) ? 'to arm ' + action : 'off';
        what = '$(bell-dot) **Popup only - nothing is stopped or powered off.**  \n' +
            'Puts a popup on the DESKTOP - on top of whatever application you are in, not just a ' +
            'notification inside VS Code - when the trigger below is met, then stays quiet until some ' +
            'session actually starts working again.';
    } else {
        text = '$(power) Status: off';
        click = 'sound';
        // Built from what this machine can actually do, rather than from the four gears the
        // MODES list happens to hold: on a platform with no command for the configured
        // action the armed gear is not in the cycle at all, and describing it here would be
        // an advertisement for a click that never arrives.
        what = '$(power) **Off - nothing happens when your sessions finish.**  \n' +
            (powerAvailable(action)
                ? 'Click through four gears: **sound** (a chime), **notify** (a desktop popup), **armed** (' +
                  action + ' this machine, after a cancellable countdown), and back to off. All three watch ' +
                  'for the same thing.'
                : 'Click through two gears: **sound** (a chime) and **notify** (a desktop popup), then back ' +
                  'to off. Both watch for the same thing.  \n' +
                  'The **armed** gear is not offered here: there is no "' + action + '" power action on ' +
                  platform.name + ', so arming would count down and then have nothing to run. Set ' +
                  '`chutdown.action` to **test** and it comes back - the whole sequence runs, and nothing ' +
                  'is powered off.');
    }
    shared.paint(shared.items.toggle, { text, backgroundColor: background, tooltip: toggleHover(what, click) });
}

// Asked at the CLICK, not two minutes into an unattended countdown. On macOS the power
// action is an Apple event and macOS gates those behind a consent prompt charged to Visual
// Studio Code - one grant per (VS Code, System Events) pair, covering shut down, restart
// and log out alike. Left to the power action, that prompt appears at the end of a
// countdown with nobody in the room, blocks the event until answered, and after two
// minutes fails; answered with "Don't Allow" it is remembered for ever and never asked
// again. Once per window, and only when the action is a real one.
let automationProbed = false;

function probeAutomation() {
    if (automationProbed) return;
    const action = shared.cfg().get('action');
    if (action === 'test') return;
    // The action goes with the question. macOS ignores it - one Automation grant covers
    // all three verbs - but logind authorises each separately, and asking it about
    // powering the machine off when the configured action is a log out produced a warning
    // whose every clause was false for what was actually going to happen.
    const cmd = platform.automationProbeCommand(action);
    if (!cmd) return;                         // nothing to prime on this platform
    automationProbed = true;
    cp.exec(cmd, platform.execOpts, (e, stdout, stderr) => {
        if (!e) { shared.nlog('power: ' + platform.name + ' lets Chutdown run the power action'); return; }
        const hint = platform.powerHint(String(stderr || '') + ' ' + String(e.message || ''));
        shared.nlog('power: permission check failed - ' + e.message + (hint ? ' - ' + hint : ''));
        if (hint) vscode.window.showWarningMessage('Chutdown will not be able to power this machine off: ' + hint);
    });
}

// The gear that cannot be honoured is not offered. platform/index.js hands anything that
// is not Windows, macOS or Linux to darwin.js as a fallback, and its powerCommand() is ''
// off a Mac - so on a FreeBSD box, or any other POSIX desktop, there is no shutdown, no
// restart and no log out to arm. What the toggle used to do with that was arm anyway: it
// announced "shutdown as soon as every Claude session has finished", ran the full
// two-minute countdown, Ctrl+C'd every dev server in the workspace through batch.stopAll,
// and then reached execute() with an empty string and nothing to run. The work was
// destroyed in exchange for nothing.
//
// The stopAll half of that is already fixed - powerAvailable() is asked before the servers
// go down - and what is left is the theatre in front of it, which is the part the platform
// rule is actually about. A control that cannot act is not presented as if it can, and the
// place to say so is the click, not the end of a countdown nobody is watching. So the
// armed gear is SKIPPED: off -> sound -> notify -> off, with one refusal that names the
// action, the platform, and the two ways out of it.
//
// The question asked is a CAPABILITY one and never an OS one, which is what makes it
// survive a platform being implemented: Linux had no power command when this was written
// and has one now (`systemctl poweroff`, behind isLinux in platform/darwin.js), and nothing
// here had to change for the gear to come back. It cuts the other way too, and that is the
// half worth keeping in mind - "Linux" is not one answer. Every Linux power verb is a
// request to logind, so on a box systemd did not boot (a container, a WSL distro without
// systemd=true, Devuan, Alpine) darwin.js answers '' just as a BSD does, and this gear
// refuses there while arming perfectly on the desktop next to it. Asking the platform for
// a command rather than for its name is the only reason that comes out right. The same
// question also catches an `action` that this OS has no verb for while the others do.
//
// The next gear is decided before it is assigned rather than assigned and then corrected,
// because a mode that is briefly 'armed' is a mode writeGear() can publish to every other
// window on the machine.
function cycleMode() {
    const action = shared.cfg().get('action');
    let next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    if (next === 'armed') {
        if (!powerAvailable(action)) {
            refuseArm(action).catch(() => { });
            next = MODES[(MODES.indexOf(next) + 1) % MODES.length];   // armed -> off
        }
    }
    mode = next;
    updateToggle();
    writeGear();   // arming (or turning off) is a decision about the machine, not this window
    if (mode === 'sound') {
        // Primed, not triggered: if everything is finished ALREADY we do not chime at
        // the click - you are sitting at the keyboard. The next finish does chime.
        announced = allFinished();
        vscode.window.showInformationMessage(
            'Chutdown sound: ' + soundName() + ' plays as soon as every Claude session in this workspace ' +
            'has finished its turn. Nothing is stopped or powered off.', 'Play it now')
            .then((pick) => { if (pick) playSound(); }, () => { });
    } else if (mode === 'notify') {
        announced = allFinished();
        vscode.window.showInformationMessage(
            'Chutdown notify: a desktop popup - on top of whatever you are in, not just an editor ' +
            'notification - as soon as every Claude session in this workspace has finished its turn. ' +
            'Nothing is stopped or powered off.', 'Show it now')
            .then((pick) => { if (pick) notifyNow(); }, () => { });
    } else if (mode === 'armed') {
        // Asked here and nowhere else - in particular NOT from syncGear, where another
        // window did the arming and there is nobody at this keyboard to answer a prompt.
        probeAutomation();
        // Only reached with a real command behind `action`: the guard above turned the
        // click away otherwise, so this notification can state plainly what is going to
        // happen instead of hedging it. forceNote is the other half of that plain
        // statement - see forceApplies().
        vscode.window.showInformationMessage(
            'Chutdown armed: ' + action + ' as soon as every Claude session in this ' +
            'workspace has finished its turn' + quietSuffix() + ', after a cancellable ' +
            shared.cfg().get('countdownSeconds') + 's countdown.' + forceNote(action));
    }
    tick().catch(() => { });
}

/// The click that could not be honoured, answered at the click. Not a bare "no": the two
/// things that would make it work are both one action away, so both are offered - `test`
/// runs the entire sequence (the wait, the countdown, the window, the peer ledger, the
/// stand-down re-checks) and stops short only of the power command itself, which on a
/// platform that has no power command is the whole of what is missing.
///
/// The setting is written into the scope it is ALREADY set in, the same dance pickSound
/// does: a workspace-level `action` must not be silently shadowed by a global write the
/// user never sees take effect. And nothing is rewritten without being asked - a default
/// that quietly varied by platform would leave a settings file saying one thing and the
/// machine doing another, which is the same dishonesty from the other end.
async function refuseArm(action) {
    const TEST = 'Use the test action';
    const SETTINGS = 'Open settings';
    const pick = await vscode.window.showWarningMessage(
        'Chutdown will not arm: there is no "' + action + '" power action on ' + platform.name +
        '. Arming would wait, count down for ' + shared.cfg().get('countdownSeconds') +
        's, stop your dev servers and then have nothing to run. The sound and notify gears work here.',
        TEST, SETTINGS);
    if (pick === SETTINGS) {
        vscode.commands.executeCommand('workbench.action.openSettings', 'chutdown.action');
        return;
    }
    if (pick !== TEST) return;
    const inspect = shared.cfg().inspect('action') || {};
    const target = inspect.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
        : inspect.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await shared.cfg().update('action', 'test', target);
    // Straight back into the gear the click was for. Re-entered from the gear BEFORE it, so
    // the arm path is the identical one a second click would have taken - the Automation
    // probe, the ledger write, the notification - rather than a second copy of it here. A
    // gear the user has moved on to in the meantime is left alone.
    if (mode !== 'off') return;
    mode = 'notify';
    cycleMode();
}

// ------------------------------------------------------------ react, don't wait
//
// The 5s poll is only the backstop: the transcripts themselves say when something
// changed, so a recursive watch on ~/.claude/projects turns "up to 5 seconds late"
// into "as soon as the turn's last record lands". Debounced, and never more than one
// scan a second, so a session writing flat out cannot spin the scanner.
let watcher = null;
let pendingWake = null;
let lastWake = 0;

function watchTranscripts() {
    const dispose = () => {
        if (pendingWake) { clearTimeout(pendingWake); pendingWake = null; }
        if (watcher) { try { watcher.close(); } catch { } watcher = null; }
    };
    try {
        // `name` is the path that moved, relative to ~/.claude/projects:
        // "<project folder>\<session>.jsonl". A write under ANOTHER project cannot
        // change anything shown here, and on a machine with a couple of dozen projects
        // those are most of the wakes - one a second, each dragging a full tick behind
        // it. Anything unnamed (the platform does not always say) still wakes it.
        watcher = fs.watch(shared.PROJECTS, { recursive: true }, (ev, name) => {
            // `name` arrives RELATIVE to the watched directory on both platforms, so the
            // first segment is the project folder. If that ever stops holding - an absolute
            // name, or a realpath that differs because ~/.claude is a symlink - every wake
            // would be discarded in silence, leaving the 5s poll as the only pump with not
            // one line anywhere to say so, and an absolute name is the shape that hides it
            // best: "/Users/me/.claude/projects/proj/x.jsonl" splits to "Users" and
            // "C:\Users\me\..." to "C:", both of them perfectly readable strings that
            // mayHoldOurs then says no to. So a name that is absolute is not read at all -
            // it is forced back to '' first, which is the value the test below lets
            // through. An unrecognisable name wakes it; only a name we can read AND can
            // rule out is dropped.
            const rel = name && !/^([\\/]|[A-Za-z]:)/.test(String(name)) ? String(name) : '';
            const first = rel ? rel.split(/[\\/]/).filter(Boolean)[0] : '';
            if (first && !scan.mayHoldOurs(first)) return;
            if (pendingWake) return;
            pendingWake = setTimeout(() => {
                pendingWake = null;
                lastWake = Date.now();
                tick().catch(() => { });
            }, Math.max(250, 1000 - (Date.now() - lastWake)));
        });
        watcher.on('error', () => { });
    } catch (e) {
        watcher = null;
        shared.nlog('watch: ' + e.message + ' - falling back to the 5s poll alone');
    }
    return { dispose };
}

let seeded = false;

async function tick() {
    scan.scanSessions();
    // First scan of the window: everything that had no tab when we last saved starts
    // idle rather than as a light. Uses the PERSISTED binding record, so it does not
    // have to wait for the restored terminals' pids to resolve.
    if (!seeded) { seeded = true; lights.seedIdle(); }
    claude.bindClaudeTerminals();  // before render: binding decides local color vs white
    claude.saveBindings();         // persist terminal<->session pairs across window reloads

    // Everything above decides the answer; everything in here only DRAWS it. A throw
    // in any of them used to reject tick() - swallowed by every caller's .catch - and
    // take the rest of the poll with it, including the trigger below: an armed
    // shutdown that silently never fires again, with nothing said anywhere. A usage
    // number over 100% was enough to do it. Each part fails alone now, and says so.
    const draw = (what, fn) => { try { fn(); } catch (e) { shared.nlog(what + ': ' + (e && e.message ? e.message : e)); } };
    draw('lights', () => lights.renderSessions());
    shared.clearGate('scan');   // the lights are on screen: half the startup spinner
    draw('rename', () => claude.renameActiveClaude());
    draw('stop button', () => batch.updateStopItem());
    draw('usage', () => usage.usageTick());
    draw('port probe', () => {
        for (const rec of shared.termRecs.values())
            if (rec.port !== undefined && !rec.exited) batch.probePort(rec);
    });

    // The heartbeat is written whatever gear this window is in, including OFF: it is how
    // an armed window somewhere else knows this one is still working. And the gear itself
    // is read back, so arming in one window shows up here within a poll.
    draw('peers', writePeer);
    draw('gear sync', syncGear);

    if (firing || mode === 'off') return;
    updateToggle();   // the tooltip names whatever is still running

    const done = allFinished();

    if (mode === 'sound' || mode === 'notify') {
        // Edge-triggered: chime (or pop up) on the transition into "all finished", then
        // stay silent until something starts working again. The gear stays engaged.
        //
        // Re-arming is deliberately NOT "!done": that would rearm every time the
        // trigger merely lapsed - a bookkeeping write, a session appearing and being
        // read a moment later - and each lapse buys a second chime for the same piece
        // of work. Only something actually RUNNING again earns the next one.
        if (!done) { if (status().busy.length) announced = false; return; }
        if (!announced) { announced = true; if (mode === 'sound') chime(); else notifyDone(); }
        return;
    }

    if (!done) return;
    // A session waiting on an ANSWER is not finished work, whatever its transcript's stop
    // reason says: the turn ended because Claude asked you something, and powering the
    // machine off over the top of the question throws that answer away.
    const questions = askingNow();
    if (questions.length) {
        shared.nlog('armed: everything has stopped, but ' + questions.length +
            ' session(s) are waiting on an answer: ' + busyNames(questions));
        return;
    }
    // ...and every OTHER window too. One machine: another window mid-turn on a different
    // project is exactly as good a reason not to power off as one of ours.
    const elsewhere = peerBusyList();
    if (elsewhere) {
        shared.nlog('armed: this workspace is finished, waiting on ' + elsewhere);
        return;
    }
    // quietMinutes is an OPTIONAL extra hold on top of "everything finished" (0 by
    // default now that finished means finished), not the thing that decides it.
    const quietMs = (Number(shared.cfg().get('quietMinutes')) || 0) * 60_000;
    const watched = status().watched;
    if (quietMs !== 0 && !watched.every((s) => finishedMs(s) >= quietMs)) return;
    // ...and LAST, the one walk the scan stopped paying for, paid for here - see above.
    // Every check in front of it is answered from memory and turns most polls away; this
    // one costs two directory trees per watched session, so it runs only once everything
    // else has already said fire.
    if (backgroundResumed()) {
        shared.nlog('armed: a background agent is writing again - not finished');
        return;
    }
    fire(watched.length);
}

// ---------------------------------------------------------- the countdown you can see
//
// The VS Code notification counts down where you are not looking. The armed gear's whole
// premise is that you walked away - so the countdown also comes up as a DESKTOP window,
// always on top, ticking every second, with a Cancel button (src/countdown.ps1 on
// Windows and src/countdown.sh - zenity - on Linux; an osascript dialog with `giving up
// after` on macOS, the one platform where a dialog cannot be redrawn to tick). Both run
// at once and either one stops it: whichever you reach first.
// The desktop window carries a second button as well - "<action> now", for when you are
// standing there and have no interest in watching the rest of the clock.
//
// The ANSWER decides, and there are three of them, identical on both platforms: exit 0
// with nothing printed is "it ran out", and the two answers that mean something else each
// print a token this process minted milliseconds before the launch - CHUTDOWN:NOW:<token>
// for the "<action> now" button, CHUTDOWN:CANCEL:<token> for a cancel. Nonzero carrying
// NEITHER token is a window that never appeared, and the machine stays on.
//
// The token is what makes that safe. An exit code is provenance-free - a missing
// PowerShell, a blocked ExecutionPolicy, an antivirus shim and a real button press are all
// just numbers, and the "now" answer is the one that shortens the wait, so it had better
// be one that nothing but the window itself can give. So both meaningful answers are
// carved out of the already-safe nonzero branch, never out of the "ran out" branch: a
// child that failed to start cannot counterfeit a string it never saw.
//
// "Do it now" skips the rest of the WAIT and nothing else. It rejoins the run-out path at
// the same line, so the full everyoneFinished() re-check and the batch stopAll still
// happen - see fire().
//
// The countdown window is an EXTRA affordance, not the decision-maker - the notification
// countdown works on its own and always has (countdownPopup: false is a supported
// setting). So a window that cannot be launched is latched here and simply not tried
// again this session, and the run after it counts down in the notification alone. What it
// must not do is what it used to: exit nonzero, read as "cancelled by the user", disarm
// the gear, and tell the user they cancelled a window that never appeared.
let countdownWindowBroken = '';

function startCountdownWindow(secs, action, onCancel, onNow, onFailed) {
    if (!shared.cfg().get('countdownPopup')) return null;
    if (countdownWindowBroken) return null;
    // Which file, if any: Windows has a .ps1 and Linux a .sh, and macOS builds its
    // window inline and wants none - so the path is the platform's to name, not this
    // module's. countdownCommand() is what returns '' for a platform with no window.
    const script = platform.countdownScript
        ? path.join(extDir(), 'src', platform.countdownScript) : '';
    // Minted per launch: "do it now" is the one answer that shortens the wait, so it has
    // to be one no failure can produce. See src/countdown.ps1's header.
    const token = crypto.randomBytes(8).toString('hex');
    const mark = new RegExp('CHUTDOWN:(NOW|CANCEL):' + token);
    const cmd = platform.countdownCommand(script, notifyTitle(),
        'Every Claude session has finished.', action, secs, token);
    if (!cmd) { shared.nlog('countdown window: not available on ' + platform.name); return null; }
    const child = cp.exec(cmd, platform.execOpts, (e, stdout, stderr) => {
        child.__done = true;
        // Our own kill (the notification's Cancel got there first, or it ran out): the
        // caller already knows, and a killed child cannot have printed anything.
        if (child.__killed) return;
        if (!e) return;                          // exit 0 - it ran out; the loop ends on its own
        // Windows prints the token on stdout; macOS raises it as an AppleScript error
        // message on stderr. One regex over both covers the pair.
        const m = mark.exec(String(stdout || '') + String(stderr || ''));
        if (m && m[1] === 'NOW') {
            shared.nlog('countdown window: "' + action + ' now" - skipping the rest of the wait');
            onNow();
            return;
        }
        if (m) { shared.nlog('countdown window: cancelled by the user'); onCancel(); return; }
        // Neither token: PowerShell missing, ExecutionPolicy, osascript gone, the script
        // failing to parse. Unexplained, so the machine stays on - but nobody cancelled
        // anything, so the gear does not go off either.
        countdownWindowBroken = e.message;
        shared.nlog('countdown window: ' + e.message + ' - not tried again this session');
        onFailed(e.message);
    });
    return child;
}

function stopCountdownWindow(child) {
    // A child that has already exited must not be killed by pid: on Windows the pid can
    // have been reused by then, and after the change above the run-out, cancel AND "now"
    // paths all reach here with the child already gone.
    if (!child || child.__done) return;
    child.__killed = true;              // set BEFORE the kill, so the callback can see it
    // The tree, not the process: the visible window is a child of the powershell (or the
    // osascript) we spawned, and killing only the parent leaves it on screen counting down
    // to nothing.
    if (child.pid) platform.killPid(child.pid).catch(() => { });
    else try { child.kill(); } catch { /* already gone */ }
}

/// ONE countdown, however many windows are armed. They all watch the same machine and
/// they all become satisfied within a poll of each other, so without this every armed
/// window puts up its own countdown window and its own notification, and each one runs
/// the power action at the end. Whoever gets the claim runs it; the rest stand down and
/// keep watching, so if the claimer's window is closed mid-countdown the next poll hands
/// it to another one rather than nobody.
///
/// The claim is an exclusive file create ('wx' is atomic), same as the chime's, with a
/// window long enough to cover the countdown itself plus the stopAll that follows.
function claimFire(windowMs) {
    const stamp = path.join(os.tmpdir(), 'chutdown-firing');
    try {
        if (Date.now() - fs.statSync(stamp).mtimeMs < windowMs) return false;
        fs.unlinkSync(stamp);                     // a stale claim from a window that died
    } catch { /* no claim yet, or another window just took it */ }
    try { fs.closeSync(fs.openSync(stamp, 'wx')); return true; }
    catch { return false; }
}

/// Said once per reason rather than once per poll - the same shape identify.js's miss()
/// uses. The armed gear is asked whether to fire on every tick, so a window left armed
/// against an action this OS cannot run would otherwise write the same line into the
/// channel every five seconds for the rest of the night.
let lastFireMiss = '';

function fire(count) {
    const action = shared.cfg().get('action');
    // Refused at the FRONT, ahead of claimFire() and ahead of the withProgress: a window
    // that cannot carry the action out must not take the cross-window fire claim only to
    // hand it back, and must not put a two-minute countdown on screen for something that
    // ends in nothing. The check further down, immediately before batch.stopAll, is what
    // catches an `action` changed DURING the countdown and stays exactly where it is; this
    // one is what stops the countdown ever starting.
    //
    // `mode` is deliberately left alone. The gear stays where the user put it, so setting
    // chutdown.action back to 'test' - or to an action this platform has - makes the same
    // armed gear work at the next quiet moment, with no second click. Nothing is stopped,
    // nothing is disarmed, and no countdown already running is touched.
    if (!powerAvailable(action)) {
        const why = 'armed: everything has finished, but there is no "' + action +
            '" power action on ' + platform.name + ' - nothing was stopped and nothing was powered off';
        if (why !== lastFireMiss) { lastFireMiss = why; shared.nlog(why); }
        return;
    }
    lastFireMiss = '';
    // VS Code does not coerce or reject a settings value that violates the contributed
    // schema - `"120s"` comes back as the string. Math.max(5, "120s") is NaN, the
    // countdown loop then runs zero times, and the machine powers off with no window
    // to cancel in at all. settleSeconds already guards its own Number(); so does this.
    const n = Number(shared.cfg().get('countdownSeconds'));
    const secs = Math.max(5, isFinite(n) ? n : 120);
    // Claimed BEFORE `firing` is set: a window that loses stays a live watcher rather
    // than parking itself in a countdown it is not running.
    if (!claimFire(secs * 1000 + 60_000)) {
        shared.nlog('armed: another window is running the countdown');
        return;
    }
    firing = true;
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'All ' + count + ' Claude session(s) finished - ' + action + ' pending',
            cancellable: true
        },
        async (progress, token) => {
            // The toggle is live during the countdown: clicking it off (or round to
            // sound) is a second, equally valid way to call the whole thing off - the
            // Cancel button on the notification must not be the only one. Checked every
            // second, so the click lands within a tick of it.
            let restarted = false;
            let windowCancelled = false;
            let windowNow = false;
            let windowFailed = '';        // the message, '' while the window is fine
            const win = startCountdownWindow(secs, action,
                () => { windowCancelled = true; },
                () => { windowNow = true; },
                (msg) => { windowFailed = msg || 'it did not start'; });
            for (let i = 0; i < secs; i++) {
                if (token.isCancellationRequested || windowCancelled || windowFailed || mode !== 'armed') break;
                // The trigger is re-read EVERY second, not just once before the
                // countdown. tick() returns early while `firing` is set, so this loop is
                // the only thing left watching - and two minutes is long enough for a
                // hook, a queued message, a background agent's notification, or another
                // window on the same workspace to start a turn. Cancel was never meant
                // to be the only way to stop a shutdown that is no longer warranted.
                //
                // ...and a turn starting in ANOTHER window counts: two minutes is plenty
                // of time for someone to prompt a session on a different project, and the
                // countdown notification is not on their screen.
                //
                // The CHEAP check, because this runs every second: the sidecar walk is
                // left to the one full check below, which happens before anything
                // irreversible either way.
                if (!everyoneFinishedCheap()) { restarted = true; break; }
                // "Do it now" is tested HERE and nowhere else, and both of its neighbours
                // are deliberate. Above it, so a Cancel or a toggle click that raced the
                // press still wins - the answer that leaves the machine on is the one that
                // survives a tie. Below everyoneFinishedCheap(), so "now" skips the WAIT
                // and not the CHECKS: a session that started working again in the same
                // second still produces `restarted` and the message that goes with it.
                // Everything after the loop is then the run-out path, byte for byte.
                if (windowNow) { progress.report({ message: action + ' now - as asked' }); break; }
                // The heartbeat keeps going while the countdown runs - tick() has stopped
                // updating it (it returns early on `firing`), and a window that goes quiet
                // reads as dead to everyone else within four polls.
                writePeer();
                progress.report({ message: (secs - i) + 's left - press Cancel to stop', increment: 100 / secs });
                await shared.sleep(1000);
            }
            const disarmed = mode !== 'armed';    // the toggle was clicked mid-countdown
            firing = false;
            // Whatever ended the countdown, the window goes with it - a countdown still
            // ticking on screen after the shutdown was called off is its own small horror.
            stopCountdownWindow(win);
            if (windowFailed && !disarmed && !restarted && !token.isCancellationRequested) {
                // Still ARMED on purpose. Nobody cancelled anything, so disarming would be blaming
                // the user for a window that never appeared - which is what this used to do on macOS,
                // every time, with "Chutdown cancelled from the countdown window, and disarmed."
                updateToggle();
                writeGear();
                vscode.window.showWarningMessage('Chutdown stopped: the countdown window could not be shown - ' +
                    windowFailed + '. Nothing was powered off, and the gear is still armed - the next run counts ' +
                    'down in the VS Code notification alone.');
                return;
            }
            if (!disarmed && !restarted) mode = 'off';   // leave a deliberate new gear alone
            updateToggle();
            writeGear();   // whatever the gear ended up as, every window shows the same
            if (windowCancelled && !restarted && !disarmed) {
                vscode.window.showInformationMessage('Chutdown cancelled from the countdown window, and disarmed.');
                return;
            }
            if (restarted) {
                // Still armed: the next time everything really is finished, this fires
                // again. Stopping the countdown is not the same as disarming.
                const elsewhere = peerBusyList();
                vscode.window.showInformationMessage('Chutdown stopped: a session started working again.' +
                    (elsewhere ? ' In another window: ' + elsewhere + '.' : busyList()));
                return;
            }
            if (token.isCancellationRequested || disarmed) {
                vscode.window.showInformationMessage(token.isCancellationRequested
                    ? 'Chutdown cancelled and disarmed.'
                    : 'Chutdown stopped: the toggle was turned ' + mode + ' mid-countdown.');
                return;
            }
            // Last look before anything irreversible happens - the loop's final sleep
            // is a second of blind time, and stopAll below is itself a second and a
            // half of it. Checked BEFORE stopAll, not after: aborting after the dev
            // servers have already been Ctrl+C'd would leave the workspace half torn
            // down with the machine still on.
            if (!everyoneFinished()) {
                mode = 'armed';
                updateToggle();
                writeGear();   // the gear was published as `off` above; it is armed again
                const elsewhere = peerBusyList();
                vscode.window.showInformationMessage('Chutdown stopped: a session started working again.' +
                    (elsewhere ? ' In another window: ' + elsewhere + '.' : busyList()));
                return;
            }
            // ...and the same look at the platform, for the same reason. Between arming
            // and here the `action` setting can have been changed to one this OS has no
            // command for, and stopAll on the next line is the irreversible half.
            if (!powerAvailable(action)) {
                mode = 'off';
                updateToggle();
                writeGear();
                vscode.window.showWarningMessage('Chutdown: no "' + action + '" power action on ' +
                    platform.name + ' - nothing was stopped and the gear is off.');
                shared.nlog('power: no command for "' + action + '" on ' + platform.name +
                    ' - countdown finished with nothing to run');
                return;
            }
            // Dev servers get a Ctrl+C instead of being killed mid-write by the OS.
            if (action !== 'test') await batch.stopAll(true);
            execute(action);
        });
}

/// Can this platform actually DO the configured action? The one question the whole gear is
/// built on, asked everywhere the gear makes a claim, because the answer used to arrive
/// last: platform/index.js hands an unrecognised platform to darwin.js, whose powerCommand
/// opens with `if (!isMac) return ''`, so there the command is always empty. The gear armed
/// without a word, counted down for two minutes, Ctrl+C'd every dev server in the
/// workspace, and only THEN did execute() discover it had nothing to run. Which is
/// precisely the outcome the comment above stopAll rules out for the abort path: a
/// workspace torn down with the machine still on.
///
/// So it is asked at the click (cycleMode, which refuses rather than arming), at every
/// paint (updateToggle, so a settings change cannot re-render the claim), when a gear
/// arrives from another window (syncGear), at the front of fire(), and once more
/// immediately before batch.stopAll - the last of which is the one that has to stay exactly
/// where it is, since it is the only one that catches an `action` changed mid-countdown.
///
/// 'test' is always available - it is the action that deliberately does nothing.
function powerAvailable(action) {
    if (action === 'test') return true;
    return !!platform.powerCommand(action, !!shared.cfg().get('forceCloseApps'));
}

/// Is `forceCloseApps` going to do something to this machine this time?
///
/// It is the only setting in the extension that destroys work OUTSIDE VS Code, and each
/// platform expresses it differently - /f on Windows, a bounded quit sweep before the Apple
/// event on macOS, `systemctl -i` to ignore inhibitor locks on Linux - but the cost is the
/// same one everywhere: an application that would have stopped the shutdown to ask about
/// unsaved changes does not get to.
///
/// Until the platform pass it was a no-op on macOS, where the power action is an Apple
/// event and an Apple event has no force, so the setting was accepted and ignored. It is
/// not ignored any more, and a setting that quietly acquires teeth is exactly what the
/// platform rule forbids. So the gear says what it is about to do at the moment it is armed
/// and again in its hover, rather than in the output channel afterwards, when the unsaved
/// work is already gone.
///
/// A LOG OUT is left out on purpose, on every platform: Windows applies no /f to
/// `shutdown /l`, macOS runs no sweep before `log out`, and Linux's terminate-session has
/// no inhibitor to ignore. They stay aligned rather than one of them being quietly more
/// destructive than the others.
function forceApplies(action) {
    if (!shared.cfg().get('forceCloseApps') || !platform.forceSupported) return false;
    return action === 'shutdown' || action === 'restart';
}

/// The disclosure sentence, plain enough to read the same in a notification and in a
/// Markdown hover. '' - and therefore no change at all to what either says - whenever the
/// setting is off, which is the default.
function forceNote(action) {
    if (!forceApplies(action)) return '';
    return ' forceCloseApps is on, so no other application is allowed to stop it: anything ' +
        'holding unsaved changes loses that work rather than getting a chance to save it.';
}

// One line in an output channel is not where a user who walked away is looking, and by the
// time this lands batch.stopAll has already Ctrl+C'd every dev server. So a power action
// that did not run is a warning, with whatever the platform can say about why - on macOS
// the Apple event is refused outright without the Automation grant, and the -1743 that
// says so exits 1, the same status a cancelled dialog leaves.
let powerFailedOnce = false;

function execute(action) {
    if (action === 'test') {
        vscode.window.showInformationMessage('Test run: every session finished; no power action taken.');
        return;
    }
    const force = !!shared.cfg().get('forceCloseApps');
    // The post-mortem, said at the moment it mattered. It used to have only one thing to
    // report - that the setting had been ignored - because on macOS it always was. Now the
    // usual case is the positive one, and it is the more important of the two to record:
    // this is the line that explains, tomorrow morning, why an editor somewhere came back
    // without the file you were halfway through.
    if (forceApplies(action))
        shared.nlog('power: forceCloseApps is on - no other application is allowed to stop the ' +
            action + ', and anything holding unsaved changes loses that work.');
    else if (force && !platform.forceSupported)
        shared.nlog('power: forceCloseApps is ignored on ' + platform.name +
            ' - the power action asks, it cannot force. An app with unsaved work can stop it.');
    const cmd = platform.powerCommand(action, force);
    if (!cmd) {
        vscode.window.showWarningMessage('Chutdown: no "' + action + '" power action on ' + platform.name + '.');
        shared.nlog('power: no command for "' + action + '" on ' + platform.name);
        return;
    }
    shared.nlog('power: ' + cmd);
    cp.exec(cmd, platform.execOpts, (e, stdout, stderr) => {
        if (!e) return;
        const said = String(stderr || e.message || '').split('\n')[0].trim();
        const hint = platform.powerHint(String(stderr || '') + ' ' + String(e.message || ''));
        shared.nlog('power: ' + (said || e.message) + (hint ? ' - ' + hint : ''));
        // Re-armed ONCE, so a permission that gets granted still fires tonight - and not
        // twice, so a permission that never will does not warn every three minutes until
        // morning.
        const again = powerFailedOnce;
        powerFailedOnce = true;
        mode = again ? 'off' : 'armed';
        updateToggle();
        writeGear();
        vscode.window.showWarningMessage('Chutdown: the ' + action + ' did not run - ' +
            (said || 'no reason given') + (hint ? ' ' + hint : '') +
            (again ? ' The gear is off.' : ' Still armed, so the next quiet moment tries again.'));
    });
}

Object.assign(module.exports,
    { updateToggle, cycleMode, playSound, soundChoices, pickSound, notifyNow,
      watchTranscripts, tick,
      writePeer, dropPeer, readPeers, peersBusy, peerBusyList,
      everyoneFinished, powerAvailable,
      writeGear, syncGear });

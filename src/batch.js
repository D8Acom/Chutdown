// Batch terminals - what the .terminals file describes, once src/terminals.js has
// read it (JSON, or the original one-per-line syntax): find the file, launch every
// entry as a quiet integrated terminal with its own status bar light, stream each
// command's output into the hover, probe entries with a port for real liveness, and
// stop-all (also run right before an armed power action fires).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const net = require('net');

const shared = require('./shared');
const platform = require('./platform');
const claude = require('./claude');
// Both file syntaxes - JSON and the original one-per-line - live in their own module.
const { parseTerminalsFile, sampleJson } = require('./terminals');

const isClaudeCommand = (cmd) => /^\s*claude(\s|$)/i.test(String(cmd || ''));
// A batch entry names its model on the command line, so its tab can wear that model's
// letter like a button-launched one: `claude --model claude-opus-5` -> the O.
const claudeModelArg = (cmd) => (String(cmd || '').match(/--model[= ]\s*([^\s]+)/i) || [])[1] || '';

/// How long to give a terminal to report shell integration before concluding it has
/// none. VS Code activates it a moment after the shell starts, so "not there yet" and
/// "not supported" look identical at creation time.
const INTEGRATION_GRACE_MS = 6000;

/// Run a batch entry's command, and find out whether this terminal can tell us
/// anything about it afterwards.
///
/// EVERY state a batch light has other than 🟢 comes from the shell-integration events:
/// 🟠 failed and ⚪ ended are set by executionEnded, and the hover's log lines by
/// captureExecution. A shell without integration - Command Prompt, or
/// terminal.integrated.shellIntegration.enabled turned off - fires neither, so a
/// crashed dev server kept a 🟢 light and a hover reading "(starting - logs appear
/// here)" for ever, with README promising the opposite. The command still runs; what
/// was missing was any admission that the light could no longer be trusted.
function runIn(terminal, command, rec) {
    // Already integrated: run it THROUGH the integration, which is what makes the
    // start/end events reliable rather than best-effort.
    if (terminal.shellIntegration) {
        terminal.shellIntegration.executeCommand(command);
        return;
    }
    // Not yet - send it now rather than making every terminal wait on a capability it
    // may not have, then watch for a moment to see whether the events will ever come.
    terminal.sendText(command, true);
    if (!rec) return;
    let disp = null;
    const timer = setTimeout(() => {
        if (disp) disp.dispose();
        if (terminal.shellIntegration) return;
        rec.noIntegration = true;
        shared.nlog('"' + rec.name + '": this shell has no shell integration - the light ' +
            'cannot see the command exit, and the hover cannot show its output');
        refreshTermItem(rec);
    }, INTEGRATION_GRACE_MS);
    if (!vscode.window.onDidChangeTerminalShellIntegration) return;   // older VS Code
    disp = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal !== terminal) return;
        clearTimeout(timer);
        disp.dispose();
        rec.noIntegration = false;
    });
}

/// One place that creates a batch terminal, because a `claude` entry is not an ordinary
/// one. README lists `.terminals` as one of the three ways to get a MANAGED claude tab,
/// and it was the only one that got neither the Chutdown "C" nor
/// CLAUDE_CODE_DISABLE_TERMINAL_TITLE - so the CLI kept writing its own spinner into
/// the title, and the traffic-light name only held while that tab was the active one.
function makeTerminal(name, cwd, command) {
    const isClaude = isClaudeCommand(command);
    return vscode.window.createTerminal({
        name,
        cwd,
        iconPath: isClaude ? shared.claudeIcon(claude.modelLetter(claudeModelArg(command)))
            : new vscode.ThemeIcon('server-process'),
        env: isClaude ? { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' } : undefined
    });
}

/// The names a workspace folder is searched for, in order. `.terminals` is THE file -
/// the one the sample button writes, JSON inside. Its `.json` twin is still found so a
/// folder that grew one during the era when the button wrote that name keeps working,
/// but the plain name wins when both exist: it is the canonical one.
function terminalsNames() {
    const configured = shared.cfg().get('terminalsFile') || '.terminals';
    if (/\.json$/i.test(configured)) return [configured];
    return [configured, configured + '.json'];
}

function findTerminalsFile(folders) {
    const names = terminalsNames();
    for (const f of folders) {
        const found = names.map((n) => path.join(f.uri.fsPath, n)).filter((p) => fs.existsSync(p));
        if (found.length > 1)
            shared.nlog('both ' + found.map((p) => path.basename(p)).join(' and ') +
                ' exist here - using ' + path.basename(found[0]));
        if (found.length) return found[0];
    }
    return '';
}

/// A JSON entry says which port it holds outright ("port": 3003); a line can only say
/// it in the name, as a trailing ":digits" - and only if it IS one.
/// `build:20240501 = npm run build` ends in digits too, and net.connect throws
/// ERR_SOCKET_BAD_PORT synchronously on anything over 65535: that throw came out of
/// probePort, out of the poll, and killed every tick after it - lights frozen and,
/// with the toggle armed, the power action silently never firing again.
function entryPort(e) {
    if (e.port !== undefined) return e.port;   // already validated by the parser
    const portMatch = e.name.match(/:(\d+)\s*$/);
    const named = portMatch ? Number(portMatch[1]) : undefined;
    if (named !== undefined && named >= 1 && named <= 65535) return named;
    if (named !== undefined)
        shared.nlog('"' + e.name + '": ' + named + ' is not a port (1-65535) - treating the name as plain text');
    return undefined;
}

/// Launch one entry: terminal, status bar light, record. Shared by "Start all" and the
/// by-name restart, so a single entry launched on its own is identical to one launched
/// with the batch. No show(): the panel stays closed - the status bar entry is the
/// surface, clicking it reveals the terminal when wanted.
function launchEntryRec(e, idx, cwd, port) {
    const terminal = makeTerminal(e.name, cwd, e.command);
    // A claude entry in .terminals gets the auto-rename + traffic-light title too.
    if (isClaudeCommand(e.command)) claude.trackClaude(terminal, cwd);

    // The LIVE record for this name, not any snapshot a caller captured earlier:
    // termRecs is keyed by name, so the set() below replaces whatever is there, and
    // disposing a stale snapshot instead leaves the replaced item orphaned in the
    // status bar - visible, never updated, its click a no-op, and invisible to
    // stopAll (which walks termRecs), so its server is not Ctrl+C'd before an armed
    // power action either.
    const prev = shared.termRecs.get(e.name);
    if (prev) prev.item.dispose();
    // The status bar shows only the bare process name - "detf:3003" reads as
    // "detf" down there; the full name stays on the tab and as the record key.
    // A ":port" suffix also arms a REAL liveness probe: the light is green only
    // while something is actually listening on that port.
    const label = e.name.split(':')[0].trim() || e.name;
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 900 - idx);
    item.command = { command: 'chutdown.focusTerminal', arguments: [e.name], title: 'Toggle' };
    shared.paint(item, { text: '🟢 ' + label, tooltip: e.command + '\n(starting - logs appear here)' });
    const rec = { name: e.name, label, terminal, item, lines: [], exited: false,
                  ended: false, exitCode: undefined, command: e.command, cwd,
                  port, portUp: undefined };
    shared.termRecs.set(e.name, rec);
    // After the record exists: runIn needs somewhere to record that this shell
    // turned out to have no integration, and the answer arrives seconds later.
    runIn(terminal, e.command, rec);
    return rec;
}

/// ONE batch launch at a time, and one launch per entry name.
///
/// A batch start is not atomic and never was: the `todo` loop only READS termRecs, and
/// the first write is launchEntryRec's `termRecs.set` - after the port sweep, which can
/// spend ten tries of 300 ms plus two netstat runs before it returns. A second click
/// inside that window (the button, the URI handler, an agent calling the command) built
/// the identical todo list from the identical unchanged map, and both went on to launch
/// it. launchEntryRec disposes the previous record's status bar ITEM but not its
/// terminal, then overwrites the map entry - so the first launch's terminal became
/// unreachable from termRecs: stopAll could not stop it, the armed shutdown's pre-power
/// sweep could not close it, and it sat there holding the port the second one wanted.
///
/// toggleTerminal, restartOne and stopOne have carried `rec.busy` for exactly this. The
/// batch paths simply never got the same treatment, because they have no rec to hang it
/// on until the work is already done.
let launching = false;
const launchingNames = new Set();

async function startAll() {
    if (launching) { shared.nlog('start: a batch launch is already running - ignored'); return; }
    launching = true;
    try { await startAllBody(); } finally { launching = false; }
}

async function startAllBody() {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws || ws.length === 0) {
        vscode.window.showWarningMessage('Open a folder first - .terminals lives in the workspace root.');
        return;
    }
    const names = terminalsNames();
    let filePath = findTerminalsFile(ws);
    if (!filePath) {
        const make = await vscode.window.showInformationMessage(
            'No ' + names.join(' or ') + ' file in the workspace root. Create a sample one?',
            'Create', 'Cancel');
        if (make !== 'Create') return;
        filePath = path.join(ws[0].uri.fsPath, names[0]);
        fs.writeFileSync(filePath, sampleJson(ws[0].uri.fsPath), 'utf8');
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        return;
    }
    const fileName = path.basename(filePath);

    const root = path.dirname(filePath);
    // Malformed JSON is the one parse failure worth interrupting for: the line syntax
    // can only ever skip a line it does not understand, but a single missing comma
    // takes the whole file with it - and "has no entries" would be a lie about a file
    // with six servers in it. The message carries the line and column.
    let entries;
    try { entries = parseTerminalsFile(fs.readFileSync(filePath, 'utf8')); }
    catch (e) {
        shared.nlog(fileName + ': ' + e.message);
        const open = await vscode.window.showErrorMessage(
            fileName + ' is not valid JSON: ' + e.message, 'Open file', 'Cancel');
        if (open === 'Open file') {
            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc);
        }
        return;
    }
    if (entries.length === 0) {
        vscode.window.showWarningMessage(fileName + ' has no entries ("name": "command").');
        return;
    }

    let launched = 0, skipped = 0, idx = 0;
    const todo = [];
    for (const e of entries) {
        idx++;
        const existing = shared.termRecs.get(e.name);
        // Skip only genuinely RUNNING ones; a terminal whose command already exited
        // (crashed server, clean stop) gets torn down and relaunched fresh.
        if (existing && !existing.exited && !existing.ended &&
            vscode.window.terminals.includes(existing.terminal)) {
            skipped++;
            continue;
        }
        // The cwd is settled BEFORE the old terminal is torn down. Disposing first and
        // validating second meant a mistyped `cwd` left the record in termRecs pointing
        // at a destroyed terminal and an undisposed StatusBarItem: updateStopItem hides
        // it, nothing relaunches under that name so launchEntryRec never reaches
        // prev.item.dispose(), and the dead light's click ran the relaunch branch on the
        // stale rec.cwd. Skipping while the old terminal is still intact leaves the
        // entry exactly as it was, which is what "Skipped" claims.
        const cwd = e.sub ? (path.isAbsolute(e.sub) ? e.sub : path.join(root, e.sub)) : root;
        if (!fs.existsSync(cwd)) {
            vscode.window.showWarningMessage('Skipped "' + e.name + '": folder not found: ' + cwd);
            continue;
        }
        if (existing && vscode.window.terminals.includes(existing.terminal)) {
            try { existing.terminal.dispose(); } catch { }
        }
        todo.push({ e, idx, cwd, port: entryPort(e) });
    }

    // Clear the way first. A ":port" entry we are about to (re)launch takes its port
    // back by force - whoever holds it, this window or not - because a port that is
    // still busy at launch does not fail loudly, it silently moves the server to the
    // next free port. Entries left running above are never touched.
    let freed = 0;
    const stuck = [];
    if (shared.cfg().get('freePortsOnStart') !== false) {
        const ports = [...new Set(todo.map((t) => t.port).filter((p) => p !== undefined))];
        const results = await Promise.all(ports.map((p) =>
            killPort(p).catch(() => ({ killed: 0, stillHeld: [] }))));
        for (let i = 0; i < ports.length; i++) {
            const r = results[i];
            if (!r.killed) continue;
            if (r.stillHeld.length) { stuck.push(ports[i]); continue; }   // do not claim it
            freed++;
            shared.nlog('freed port ' + ports[i] + ' (' + r.killed + ' process(es) killed)');
        }
    }

    for (const { e, idx, cwd, port } of todo) {
        launchEntryRec(e, idx, cwd, port);
        launched++;
    }
    updateStopItem();
    const msg = 'Terminals: ' + launched + ' launched, ' + skipped + ' already running' +
        (freed ? ', ' + freed + ' busy port(s) force-freed first' : '') + '.';
    // A port that would not let go is the one thing worth interrupting for: the server
    // about to launch will silently bind the NEXT port instead, which is exactly what
    // freePortsOnStart exists to prevent - and a cheerful "launched" notice would be
    // the only thing said about it.
    if (stuck.length)
        vscode.window.showWarningMessage(msg + ' Port ' + stuck.join(', ') +
            ' could not be freed - something else still holds it, so that server may ' +
            'bind a different port. See the Chutdown output channel.');
    else vscode.window.showInformationMessage(msg);
}

/// Shell integration streams each command's output; keep the tail per terminal
/// and surface it in the status bar entry's hover.
async function captureExecution(e) {
    claude.adoptClaude(e);
    let rec = null;
    for (const r of shared.termRecs.values()) if (r.terminal === e.terminal) { rec = r; break; }
    if (!rec) return;
    // A new command in the tab (user reran the server by hand) revives the light.
    if (rec.ended && !rec.exited) {
        rec.ended = false;
        rec.exitCode = undefined;
        refreshTermItem(rec);
        updateStopItem();
    }
    try {
        for await (const chunk of e.execution.read()) {
            const clean = String(chunk)
                .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')     // CSI sequences
                .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');  // OSC sequences
            for (const line of clean.split(/\r?\n/)) {
                const t = line.trimEnd();
                if (t) rec.lines.push(t);
            }
            if (rec.lines.length > 40) rec.lines = rec.lines.slice(-40);
            refreshTermItem(rec);
        }
    } catch { /* stream ended with the terminal */ }
}

/// 🟢 command running · 🟠 command died (nonzero exit - the EADDRINUSE case) ·
/// ⚪ command ended cleanly · 🔴 terminal tab closed. Entries named "name:port" trust
/// the PORT PROBE over shell events - the light is green only while the port answers.
function termLight(rec) {
    if (rec.exited) return '🔴';
    if (rec.port !== undefined && rec.portUp !== undefined)
        return rec.portUp ? '🟢' : (rec.ended && rec.exitCode !== 0 && rec.exitCode !== undefined ? '🟠' : '⚪');
    if (rec.ended) return rec.exitCode === 0 ? '⚪' : '🟠';
    return '🟢';
}

function termState(rec) {
    if (rec.exited) return 'terminal closed';
    if (rec.port !== undefined && rec.portUp !== undefined)
        return rec.portUp ? 'port ' + rec.port + ' up - click to stop'
            : 'port ' + rec.port + ' DOWN - click to restart';
    if (rec.ended) return rec.exitCode === 0 ? 'command ended - click to restart'
        : 'FAILED - exit code ' + rec.exitCode + ' - click to restart';
    // No shell integration in this terminal: nothing will ever report the command's
    // exit, so 🟢 means "we started it", not "it is running". A `name:port` entry is
    // unaffected - the socket probe above answers without the shell's help - which is
    // also the standing advice for this case.
    if (rec.noIntegration && rec.port === undefined)
        return 'started - this shell has no shell integration, so its exit cannot be ' +
            'seen (add a :port to the name for a real liveness check) - click to stop';
    return 'running - click to stop';
}

/// The ONE place a batch light is written - light, background and hover together, and
/// only when one of them actually changed (shared.paint). It used to be three writes in
/// six places, every one of them re-rendering the item and closing whatever hover was
/// open: the log tail alone repainted the item on every line a dev server printed.
function refreshTermItem(rec) {
    shared.paint(rec.item, {
        text: termLight(rec) + ' ' + (rec.label || rec.name),
        backgroundColor: termLight(rec) === '🟠'
            ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined,
        tooltip: termTooltip(rec)
    });
}

/// The truth about a ":port" entry comes from the socket, not from shell events -
/// killing the process any which way flips the light within one poll.
function probePort(rec) {
    let sock;
    // net.connect validates the port SYNCHRONOUSLY and throws. The port is validated
    // at parse time now, but this call sits inside the poll: a throw here takes the
    // whole tick with it - lights, renames, and the armed shutdown's own trigger.
    // Nothing in the poll is worth that, so the probe fails closed instead.
    try { sock = net.connect({ port: rec.port, host: '127.0.0.1' }); }
    catch (e) {
        shared.nlog('probe ' + rec.name + ': ' + e.message);
        if (rec.portUp !== false) { rec.portUp = false; refreshTermItem(rec); updateStopItem(); }
        return;
    }
    let done = false;
    const finish = (up) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch { }
        if (rec.portUp !== up) { rec.portUp = up; refreshTermItem(rec); updateStopItem(); }
    };
    sock.setTimeout(1500);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
}

/// Force-kill whatever still LISTENs on the port (Ctrl+C didn't take), then wait for
/// the socket to actually go - the kill returns before the listener is gone, and a
/// relaunch that races it just makes Next grab the next free port.
///
/// Who is listening, and how to kill them, is the OS's business (src/platform):
/// netstat + taskkill on Windows, lsof + pkill/kill on macOS. Both find servers this
/// window never started - a leftover from a previous VS Code run, or your own
/// external terminal - which is the whole point of freeing the port.
/// Returns how many pids it found - and, in `stillHeld`, whether the socket actually
/// cleared. It used to return only the count found, so a kill that was refused (a
/// service running as SYSTEM, an elevated shell) was reported to the user as "freed
/// port 3003 (1 process(es) killed)" while the port stayed exactly as busy as before -
/// the UI claiming the one outcome the setting exists to prevent.
async function killPort(port) {
    const pids = await platform.listeningPids(port);
    if (pids.length === 0) return { killed: 0, stillHeld: [] };
    await Promise.all(pids.map((pid) => platform.killPid(pid)));
    let held = pids;
    for (let i = 0; i < 10; i++) {
        held = await platform.listeningPids(port);
        if (held.length === 0) break;
        await shared.sleep(300);
    }
    if (held.length)
        shared.nlog('port ' + port + ' is STILL held by pid ' + held.join(', ') +
            ' - the kill was refused (an elevated or service-owned process?)');
    return { killed: pids.length, stillHeld: held };
}

function termRunning(rec) {
    if (rec.exited || !vscode.window.terminals.includes(rec.terminal)) return false;
    if (rec.port !== undefined && rec.portUp !== undefined) return rec.portUp;
    return !rec.ended;
}

/// Clicking a batch terminal light TOGGLES it: running -> Ctrl+C (then kill the port
/// if it will not let go), stopped -> rerun the command in the same tab, tab closed
/// -> relaunch a fresh terminal. The terminal is revealed either way.
async function toggleTerminal(name) {
    const rec = shared.termRecs.get(name);
    if (!rec) return;
    // One click at a time. Every branch below awaits - killPort alone can run for
    // three seconds - and nothing is written back to the record until afterwards, so a
    // second click during that window took the same branch and launched a SECOND
    // terminal for the one record. `rec.terminal` then kept only the last of them and
    // the first became invisible: not stopped by the stop button, not Ctrl+C'd before
    // an armed power action, still holding the port.
    if (rec.busy) return;
    rec.busy = true;
    try { await toggleTerminalBody(rec); } finally { rec.busy = false; }
}

async function toggleTerminalBody(rec) {
    const alive = !rec.exited && vscode.window.terminals.includes(rec.terminal);
    if (!alive) {
        // Same rule as a batch start: take the port back before relaunching, or the
        // new server quietly lands on a different one.
        if (rec.port !== undefined && shared.cfg().get('freePortsOnStart') !== false)
            await killPort(rec.port).catch(() => 0);
        const terminal = makeTerminal(rec.name, rec.cwd, rec.command);
        if (isClaudeCommand(rec.command)) claude.trackClaude(terminal, rec.cwd);
        rec.terminal = terminal;
        rec.exited = false; rec.ended = false; rec.exitCode = undefined;
        rec.portUp = undefined; rec.lines = []; rec.noIntegration = false;
        runIn(terminal, rec.command, rec);
        refreshTermItem(rec);
        updateStopItem();
        return;
    }
    rec.terminal.show(true);
    if (termRunning(rec)) {
        try { rec.terminal.sendText('\u0003', false); } catch { }
        if (rec.port !== undefined) {
            await shared.sleep(1500);
            probePort(rec);
            await shared.sleep(500);
            if (rec.portUp !== false) await killPort(rec.port).catch(() => 0);
        }
    } else {
        rec.ended = false; rec.exitCode = undefined;
        if (rec.port !== undefined) {
            rec.portUp = undefined;
            if (shared.cfg().get('freePortsOnStart') !== false)
                await killPort(rec.port).catch(() => 0);
        }
        try { runIn(rec.terminal, rec.command, rec); } catch { }
        refreshTermItem(rec);
    }
    updateStopItem();
}

/// A name as an agent (or a person typing a URI) would give it: the full entry name
/// ("detf:3003") or the bare label the status bar shows ("detf"), case-insensitive.
function findRec(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    for (const [key, rec] of shared.termRecs)
        if (key.toLowerCase() === want) return rec;
    for (const rec of shared.termRecs.values())
        if ((rec.label || '').toLowerCase() === want) return rec;
    return null;
}

/// One yes/no probe, for the by-name /start skip - probePort writes to a record, and
/// the entry being asked about may not have one yet.
const portListening = (port) => new Promise((res) => {
    let sock;
    try { sock = net.connect({ port, host: '127.0.0.1' }); } catch { return res(false); }
    const fin = (v) => { try { sock.destroy(); } catch { } res(v); };
    sock.setTimeout(1000);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
});

/// Restart ONE entry by name - what clicking its light does, minus the mouse. This is
/// the agent-facing action (vscode://d8a.chutdown/restart?name=detf&ws=…): stop it
/// if it is running, take its port back, run its command again, and leave the server
/// in a user-owned tab. A name with no record yet - the batch was never started in
/// this window - is looked up in the .terminals file and launched on its own.
/// `onlyIfDown` is the /start variant: a server that is already up is left alone,
/// the same skip "Start all" gives running entries.
async function restartOne(name, onlyIfDown) {
    const rec = findRec(name);
    if (!rec) return launchOneFromFile(name, onlyIfDown);
    if (rec.busy) return true;
    if (onlyIfDown && termRunning(rec)) {
        shared.nlog('start "' + rec.name + '": already running - left alone');
        return true;
    }
    rec.busy = true;
    try { await restartRec(rec); } finally { rec.busy = false; }
    return true;
}

async function restartRec(rec) {
    const alive = !rec.exited && vscode.window.terminals.includes(rec.terminal);
    if (alive && termRunning(rec)) {
        try { rec.terminal.sendText('\u0003', false); } catch { }
        await shared.sleep(1500);
    }
    // An explicit restart means the port MUST come back whoever holds it - the same
    // no-questions reclaim as the toggle's stop branch, not gated on freePortsOnStart:
    // "restart detf" with the port left to a stranger would relaunch onto 3004.
    if (rec.port !== undefined) await killPort(rec.port).catch(() => 0);
    rec.ended = false; rec.exitCode = undefined; rec.lines = [];
    if (rec.port !== undefined) rec.portUp = undefined;
    if (alive) {
        try { runIn(rec.terminal, rec.command, rec); } catch { }
    } else {
        const terminal = makeTerminal(rec.name, rec.cwd, rec.command);
        if (isClaudeCommand(rec.command)) claude.trackClaude(terminal, rec.cwd);
        rec.terminal = terminal;
        rec.exited = false; rec.noIntegration = false;
        runIn(terminal, rec.command, rec);
    }
    refreshTermItem(rec);
    updateStopItem();
    shared.nlog('restarted "' + rec.name + '"');
}

/// The by-name restart's cold path: nothing launched under this name yet, so find its
/// entry in .terminals and launch just that one. Non-interactive on purpose - the
/// caller is a shell command, not a click - so every failure is a line in the output
/// channel naming what WAS found, never a dialog.
/// Keyed on the requested name rather than on a rec, because the whole point is that
/// no rec exists yet - the URI handler can fire /restart?name=web twice in a second and
/// the second call would otherwise launch a duplicate terminal over the first.
async function launchOneFromFile(name, onlyIfDown) {
    const key = String(name || '').trim().toLowerCase();
    if (launchingNames.has(key)) {
        shared.nlog('launch "' + name + '": already launching - ignored');
        return true;               // in flight, not failed: the caller's intent is being served
    }
    launchingNames.add(key);
    try { return await launchOneFromFileBody(name, onlyIfDown); }
    finally { launchingNames.delete(key); }
}

async function launchOneFromFileBody(name, onlyIfDown) {
    const ws = vscode.workspace.workspaceFolders;
    if (!ws || ws.length === 0) return false;
    const filePath = findTerminalsFile(ws);
    if (!filePath) { shared.nlog('restart "' + name + '": no .terminals file in the workspace root'); return false; }
    let entries;
    try { entries = parseTerminalsFile(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { shared.nlog('restart "' + name + '": ' + path.basename(filePath) + ': ' + e.message); return false; }
    const want = String(name || '').trim().toLowerCase();
    let idx = 0, hit = null, hitIdx = 0;
    for (const e of entries) {
        idx++;
        if (hit) continue;
        if (e.name.toLowerCase() === want ||
            (e.name.split(':')[0].trim().toLowerCase()) === want) { hit = e; hitIdx = idx; }
    }
    if (!hit) {
        shared.nlog('restart "' + name + '": no such entry in ' + path.basename(filePath) +
            ' (have: ' + (entries.map((e) => e.name).join(', ') || 'nothing') + ')');
        return false;
    }
    const root = path.dirname(filePath);
    const cwd = hit.sub ? (path.isAbsolute(hit.sub) ? hit.sub : path.join(root, hit.sub)) : root;
    if (!fs.existsSync(cwd)) { shared.nlog('restart "' + hit.name + '": folder not found: ' + cwd); return false; }
    const port = entryPort(hit);
    // /start finding the port already answering means a server IS up - just not one
    // this window launched (the user's own terminal, a previous VS Code run). Start
    // leaves it alone; only an explicit restart takes it over.
    if (onlyIfDown && port !== undefined && await portListening(port)) {
        shared.nlog('start "' + hit.name + '": port ' + port + ' is already answering - left alone');
        return true;
    }
    if (port !== undefined) await killPort(port).catch(() => 0);
    launchEntryRec(hit, hitIdx, cwd, port);
    updateStopItem();
    shared.nlog('launched "' + hit.name + '" from ' + path.basename(filePath));
    return true;
}

/// Stop ONE entry by name - Ctrl+C, and for a ":port" entry take the port down even if
/// the Ctrl+C was ignored. The tab stays open, same as the toggle's stop branch.
async function stopOne(name) {
    const rec = findRec(name);
    if (!rec) { shared.nlog('stop "' + name + '": no such terminal'); return false; }
    if (rec.busy) return true;
    rec.busy = true;
    try {
        const alive = !rec.exited && vscode.window.terminals.includes(rec.terminal);
        if (alive) {
            try { rec.terminal.sendText('\u0003', false); } catch { }
            await shared.sleep(1500);
        }
        if (rec.port !== undefined) {
            probePort(rec);
            await shared.sleep(500);
            if (rec.portUp !== false) await killPort(rec.port).catch(() => 0);
        }
        refreshTermItem(rec);
        updateStopItem();
        shared.nlog('stopped "' + rec.name + '"');
    } finally { rec.busy = false; }
    return true;
}

/// The command a batch terminal was born to run has finished. For a dev server that
/// means crashed (nonzero exit -> orange light) or stopped; either way it is no
/// longer "green".
function executionEnded(e) {
    for (const rec of shared.termRecs.values()) {
        if (rec.terminal !== e.terminal || rec.exited || rec.ended) continue;
        rec.ended = true;
        rec.exitCode = e.exitCode === undefined ? -1 : e.exitCode;
        refreshTermItem(rec);
    }
    updateStopItem();
}

/// "$(debug-stop) stop" sits next to ".terminals" whenever batch terminals are up.
function updateStopItem() {
    const open = [...shared.termRecs.values()]
        .filter((r) => !r.exited && vscode.window.terminals.includes(r.terminal));
    if (open.length === 0) { shared.unpaint(shared.items.stop); return; }
    shared.paint(shared.items.stop, {
        text: '$(debug-stop) stop',
        tooltip: 'Ctrl+C and close all ' + open.length + ' .terminals terminal(s)'
    });
}

/// Ctrl+C every batch terminal so dev servers exit cleanly, then close their tabs and
/// retire their lights. Also runs (silently) right before an armed power action.
async function stopAll(silent) {
    const open = [...shared.termRecs.values()]
        .filter((r) => !r.exited && vscode.window.terminals.includes(r.terminal));
    if (open.length === 0) {
        if (!silent) vscode.window.showInformationMessage('No .terminals terminals running.');
        return;
    }
    for (const r of open) { try { r.terminal.sendText('\u0003', false); } catch { } }
    await shared.sleep(1500);
    for (const r of open) { try { r.terminal.dispose(); } catch { } }
    for (const [name, r] of [...shared.termRecs]) { r.item.dispose(); shared.termRecs.delete(name); }
    updateStopItem();
    if (!silent) vscode.window.showInformationMessage('Stopped ' + open.length + ' terminal(s).');
}

/// Stop everything, then start it again from the file - the one action an agent
/// editing this workspace actually wants ("I changed the config, bounce the servers"),
/// and the one that was only expressible as two clicks. stopAll runs silently: two
/// notifications for one intention is one too many, and the second one says what
/// happened anyway.
async function restartAll() {
    if (launching) { shared.nlog('restart all: a batch launch is already running - ignored'); return; }
    launching = true;
    // startAllBody, not startAll: the flag this holds is the one startAll checks, and
    // a restart that refused its own launch would stop everything and start nothing.
    try { await stopAll(true); await startAllBody(); } finally { launching = false; }
}

function termTooltip(rec) {
    const md = new vscode.MarkdownString();
    // Narrowed, and the text escaped: a dev server's output is the least trustworthy
    // text in the extension - it can carry a request path, a webhook payload, an npm
    // banner - and it lands in a hover that has to be trusted for the Copy link to
    // work. appendCodeblock fences with exactly ``` and does not escape, so a log line
    // of ``` closed the block and everything after it rendered as trusted markdown.
    md.isTrusted = { enabledCommands: ['chutdown.copyTerminalLog'] };
    md.supportThemeIcons = true;
    md.appendMarkdown('**' + shared.mdText(rec.command) + '**  \n_' + termState(rec) + '_\n');
    md.appendMarkdown(shared.mdCode(rec.lines.slice(-15).join('\n') || '(no output yet)', 'text'));
    // A hover cannot be selected, and a crashed server's last lines are exactly what
    // you want to paste somewhere - so the log gets a clipboard link too. It copies
    // ALL kept lines (40), not just the 15 the hover has room for.
    const arg = encodeURIComponent(JSON.stringify([rec.name]));
    md.appendMarkdown('\n[$(copy) Copy log](command:chutdown.copyTerminalLog?' + arg + ')');
    return md;
}

async function copyTerminalLog(name) {
    const rec = shared.termRecs.get(name);
    if (!rec) return;
    const text = [rec.name + ' - ' + termState(rec), '$ ' + rec.command,
        rec.cwd ? 'cwd: ' + rec.cwd : '', '',
        rec.lines.join('\n') || '(no output yet)'].filter(Boolean).join('\n');
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage('Copied the ' + (rec.label || rec.name) + ' log (' +
        rec.lines.length + ' line(s)).', 3000);
}

function onTerminalClosed(terminal) {
    for (const rec of shared.termRecs.values()) {
        if (rec.terminal !== terminal) continue;
        rec.exited = true;
        refreshTermItem(rec);
    }
    updateStopItem();
    claude.claudeTabClosed(terminal);
}

/// Same as the session lights: these items are created per batch terminal, never
/// handed to context.subscriptions, and so survive the extension being torn down.
/// The terminals themselves are deliberately left running - a reload should not kill
/// your dev servers - it is only the status bar entries that have to go.
function disposeTermItems() {
    for (const rec of shared.termRecs.values()) { try { rec.item.dispose(); } catch { } }
}

Object.assign(module.exports, {
    startAll, stopAll, restartAll, restartOne, stopOne, findRec,
    updateStopItem, toggleTerminal,
    captureExecution, executionEnded, onTerminalClosed, copyTerminalLog,
    probePort, termLight, termState, disposeTermItems
});

// Chutdown for VS Code.
//
// Three things, all living in the status bar (the bottom tray):
//  - Traffic lights, one status bar entry per Claude Code session in this workspace,
//    named after the session's first prompt. 🟢 processing, 🟠 asking for input,
//    🔴 finished. Hover shows the latest assistant output; CLICK reveals that
//    session's terminal in the main editor area (or opens its transcript there).
//    State comes from the transcripts Claude Code writes under ~/.claude/projects —
//    same detection as the desktop app.
//  - "Start all": launches every command listed in the workspace's .terminals file as
//    integrated terminals - created quietly, the panel does not pop up. Each gets a
//    status bar entry whose hover shows its latest log lines (shell-integration API);
//    the light goes 🟠 if the command dies (nonzero exit - a crashed dev server).
//    A "stop" button appears while any are running: Ctrl+C to all, then close them
//    (also runs automatically before an armed power action fires).
//  - An armable shutdown, clicked through four gears (off -> sound -> notify -> armed
//    -> off): "sound" chimes when every session in the workspace has finished, "notify"
//    puts a desktop popup on screen (an OS one, on top of whatever you are in - not
//    just an editor notification), and "ARMED" runs a cancellable countdown on the same
//    trigger and then powers the machine down. The status bar item is "Status", and
//    names the gear it is in: off / sound / notify / shutdown (or whichever power
//    action is configured).
//
// Deliberately absent: recaps and replying to sessions - Claude in VS Code does that.
//
// This file is only the ENTRY POINT: it creates the status bar items and wires up
// commands/events. Each section lives in its own module under src/:
//   src/shared.js   - cross-section state: session/terminal maps, items, helpers
//   src/platform/   - the OS calls: sound, power action, port kill, claude shell
//   src/scan.js     - transcript scanning, state detection, scanned-word names
//   src/claude.js   - claude terminals: launch buttons, tab renaming, binding
//   src/lights.js   - traffic light status bar entries + dropdowns
//   src/naming.js   - AI verification of tab names (claude -p)
//   src/identify.js - which session a tab is running, from claude's own pid files
//   src/usage.js    - the usage meter
//   src/terminals.js- the .terminals file: JSON, or the original one-per-line syntax
//   src/batch.js    - .terminals batch terminals
//   src/shutdown.js - armable shutdown + the 5s poll

const vscode = require('vscode');
const path = require('path');

const shared = require('./src/shared');
const platform = require('./src/platform');
const claude = require('./src/claude');
const lights = require('./src/lights');
const naming = require('./src/naming');
const batch = require('./src/batch');
const shutdown = require('./src/shutdown');
const usage = require('./src/usage');

let pollTimer = null;

// ------------------------------------------- a setting that cannot do anything here
//
// `usageKeychain` asks Chutdown to read Claude Code's sign-in out of the OS credential
// store, and there is only one OS with a store to read: platform.keychainReadArgv()
// answers null on Windows and on the POSIX fallback. A setting switched on that quietly
// does nothing is the one outcome that is never allowed - the user has made a change, the
// meter behaves exactly as it did before, and nothing anywhere connects the two - so the
// moment it is switched on where there is no store, it says so where the user is standing
// and names what is read instead. It is not an error and not a warning: nothing is broken,
// and on every platform the meter already has numbers without it.
//
// Said once per switching-on rather than on every configuration event: editing
// settings.json can deliver several changes for the same key, and a stack of identical
// notifications is its own kind of noise.
let keychainSaid = false;

function keychainSettingChanged() {
    if (!shared.cfg().get('usageKeychain')) { keychainSaid = false; return; }
    if (keychainSaid || platform.keychainReadArgv()) return;
    keychainSaid = true;
    const what = 'chutdown.usageKeychain does nothing on ' + platform.name +
        ' - there is no OS credential store here for Chutdown to read the Claude Code sign-in from. ' +
        'The usage meter reads CLAUDE_CODE_OAUTH_TOKEN or ~/.claude/.credentials.json instead, and ' +
        'where there is neither it shows the reading Claude Code itself cached, labelled with its age.';
    shared.nlog('usage: ' + what);
    vscode.window.showInformationMessage('Chutdown: ' + what);
}

function activate(context) {
    shared.state.extContext = context;

    // Chutdown asks for the FIRST activation wave ("*"), because until it activates
    // there are no traffic lights and every button answers "Activating Extensions...".
    // Being early means being up before the workbench has finished restoring, though -
    // no transcripts read, no terminals back - so the first thing on screen is a
    // spinner where the lights belong. It goes when the lights are drawn AND the
    // restored tabs have been matched back to their sessions (shared.clearGate).
    shared.items.loading = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1001);
    shared.items.loading.text = '$(loading~spin) Chutdown';
    shared.items.loading.tooltip = 'Chutdown is starting: reading the transcripts and matching up the terminal tabs';
    shared.items.loading.show();
    shared.addGate('scan');   // the first render of the traffic lights
    shared.addGate('tabs');   // ...and the one-off pass over the restored tabs
    // ...and a backstop, so a pass that never reports in cannot leave the spinner
    // turning for the rest of the window's life. 90s is longer than the tab wait can be.
    const spinnerBackstop = setTimeout(() => {
        if (!shared.state.ready) shared.nlog('ready: gave up waiting for the startup passes');
        shared.clearGate('scan');
        shared.clearGate('tabs');
    }, 90_000);
    context.subscriptions.push({ dispose: () => clearTimeout(spinnerBackstop) });
    context.subscriptions.push({ dispose: () => { if (shared.items.loading) shared.items.loading.dispose(); } });

    shared.items.toggle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    shared.items.toggle.command = 'chutdown.toggle';
    shutdown.updateToggle();
    shared.items.toggle.show();

    const startAllItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    startAllItem.command = 'chutdown.startAll';
    startAllItem.text = '$(run-all) .terminals';
    startAllItem.tooltip = 'Launch every command in the workspace .terminals file';
    startAllItem.show();

    shared.items.stop = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 998.5);
    shared.items.stop.command = 'chutdown.stopAll';
    context.subscriptions.push(shared.items.stop);

    claude.buildClaudeButtons();
    // Which models the buttons offer depends on the account's plan and usage credits,
    // and the reading behind that lands on a poll - after the buttons were built from
    // whatever was cached. When it moves, they get rebuilt.
    usage.setAvailabilityListener(() => claude.buildClaudeButtons());
    context.subscriptions.push(
        { dispose: () => { for (const it of claude.claudeButtons) it.dispose(); } },
        // Status bar items created ON DEMAND rather than here - one per session, one
        // per batch terminal - plus the output channel, which is created lazily on its
        // first line. None of them can be pushed at activation, so they are disposed
        // through these instead: without them, disabling or uninstalling Chutdown left
        // its traffic lights sitting in the status bar, clicking one erroring with
        // "command 'chutdown.showSession' not found".
        { dispose: () => lights.disposeSessionItems() },
        { dispose: () => batch.disposeTermItems() },
        { dispose: () => shared.disposeLog() },
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('chutdown.claudeButtons') ||
                e.affectsConfiguration('chutdown.editorTitleButtons'))
                claude.buildClaudeButtons();
            // The namer gives up for the window the first time `claude -p` cannot be
            // spawned or answers with nothing usable, and until now the only way back
            // was a window reload. Touching either naming setting is the gesture of
            // someone who has just fixed the thing that broke it, so it lifts the latch.
            if (e.affectsConfiguration('chutdown.aiNames') ||
                e.affectsConfiguration('chutdown.aiNamesModel'))
                naming.resetNamer();
            if (e.affectsConfiguration('chutdown.usageKeychain')) keychainSettingChanged();
        }));

    shared.items.namer = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(shared.items.namer);

    shared.items.stale = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 903);
    shared.items.stale.command = 'chutdown.showStale';
    context.subscriptions.push(shared.items.stale);

    shared.items.usage = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 902);
    shared.items.usage.command = 'chutdown.cycleUsageFocus';
    context.subscriptions.push(shared.items.usage);

    context.subscriptions.push(
        shared.items.toggle, startAllItem,
        vscode.commands.registerCommand('chutdown.toggle', shutdown.cycleMode),
        vscode.commands.registerCommand('chutdown.testSound', shutdown.playSound),
        vscode.commands.registerCommand('chutdown.testNotify', shutdown.notifyNow),
        vscode.commands.registerCommand('chutdown.pickSound', () => {
            shutdown.pickSound().catch((e) => shared.nlog('pickSound: ' + e.message));
        }),
        vscode.commands.registerCommand('chutdown.startAll', batch.startAll),
        vscode.commands.registerCommand('chutdown.stopAll', () => batch.stopAll(false)),
        vscode.commands.registerCommand('chutdown.restartAll', () => {
            batch.restartAll().catch((e) => shared.nlog('restartAll: ' + e.message));
        }),
        // The same three actions from OUTSIDE the editor - `code --open-url
        // "vscode://d8a.chutdown/restart?ws=<folder>"` - because the thing most
        // likely to want the servers bounced is the agent working in this repo, and it
        // has a shell, not a mouse. `ws` is not decoration: a URI is delivered to the
        // LAST ACTIVE window, which may be a different project entirely, so a window
        // whose workspace does not match the folder asked for leaves it alone.
        vscode.window.registerUriHandler({
            handleUri(uri) {
                const action = (uri.path || '').replace(/^\/+/, '').toLowerCase();
                const want = /(?:^|&)ws=([^&]*)/.exec(uri.query || '');
                if (want) {
                    const asked = path.resolve(decodeURIComponent(want[1]));
                    const here = (vscode.workspace.workspaceFolders || [])
                        .some((f) => path.resolve(f.uri.fsPath).toLowerCase() === asked.toLowerCase());
                    if (!here) { shared.nlog('uri ' + action + ': not this workspace (' + asked + ') - ignored'); return; }
                }
                // `&name=detf` narrows the action to ONE .terminals entry - the whole
                // reason an agent reaches for the URI is usually "bounce the server I
                // just disturbed", not "bounce everything". The name matches the entry
                // ("detf:3003") or the bare label the status bar shows ("detf").
                const nm = /(?:^|&)name=([^&]*)/.exec(uri.query || '');
                const name = nm ? decodeURIComponent(nm[1].replace(/\+/g, ' ')).trim() : '';
                shared.nlog('uri: ' + (action || '(none)') + (name ? ' name=' + name : ''));
                if (name) {
                    if (action === 'restart') batch.restartOne(name).catch((e) => shared.nlog('uri restart ' + name + ': ' + e.message));
                    else if (action === 'start') batch.restartOne(name, true).catch((e) => shared.nlog('uri start ' + name + ': ' + e.message));
                    else if (action === 'stop') batch.stopOne(name).catch((e) => shared.nlog('uri stop ' + name + ': ' + e.message));
                    else vscode.window.showWarningMessage('Chutdown: unknown link "' + action + '" (try start, stop or restart).');
                    return;
                }
                if (action === 'start') batch.startAll().catch((e) => shared.nlog('uri start: ' + e.message));
                else if (action === 'stop') batch.stopAll(false).catch((e) => shared.nlog('uri stop: ' + e.message));
                else if (action === 'restart') batch.restartAll().catch((e) => shared.nlog('uri restart: ' + e.message));
                else vscode.window.showWarningMessage('Chutdown: unknown link "' + action + '" (try start, stop or restart).');
            }
        }),
        vscode.commands.registerCommand('chutdown.newClaude', claude.newClaude),
        vscode.commands.registerCommand('chutdown.pickModels', () => {
            claude.pickModels().catch((e) => shared.nlog('pickModels: ' + e.message));
        }),
        vscode.commands.registerCommand('chutdown.newClaudeSlot1', () => claude.newClaudeSlot(0)),
        vscode.commands.registerCommand('chutdown.newClaudeSlot2', () => claude.newClaudeSlot(1)),
        vscode.commands.registerCommand('chutdown.newClaudeSlot3', () => claude.newClaudeSlot(2)),
        vscode.commands.registerCommand('chutdown.newClaudeSlot4', () => claude.newClaudeSlot(3)),
        vscode.commands.registerCommand('chutdown.showTabs', lights.showTabs),
        vscode.commands.registerCommand('chutdown.showSession', claude.showSession),
        vscode.commands.registerCommand('chutdown.showStale', lights.showStale),
        vscode.commands.registerCommand('chutdown.showHistory', () => {
            lights.showHistory().catch((x) => shared.nlog('showHistory: ' + x.message));
        }),
        vscode.commands.registerCommand('chutdown.setIdleMinutes', () => {
            lights.setIdleMinutes().catch((x) => shared.nlog('setIdleMinutes: ' + x.message));
        }),
        vscode.commands.registerCommand('chutdown.setLookbackHours', () => {
            lights.setLookbackHours().catch((x) => shared.nlog('setLookbackHours: ' + x.message));
        }),
        vscode.commands.registerCommand('chutdown.dismissSession', lights.dismissSession),
        vscode.commands.registerCommand('chutdown.dismissOrphans', lights.dismissOrphans),
        // Hovers can't be selected (no VS Code API for it) - these put their text on
        // the clipboard instead, from the "Copy" link in the hover itself.
        vscode.commands.registerCommand('chutdown.copySession', (id) => {
            lights.copySession(id).catch(() => { });
        }),
        // ...and can't be edited in either - the "Edit name" link opens an input box.
        vscode.commands.registerCommand('chutdown.renameSession', (id) => {
            lights.renameSession(id).catch((e) => shared.nlog('rename: ' + e.message));
        }),
        vscode.commands.registerCommand('chutdown.copyTerminalLog', (name) => {
            batch.copyTerminalLog(name).catch(() => { });
        }),
        // The startup flick, on demand: a tab that was busy or unbound when the window
        // loaded - or one whose light moved on while it sat in the background - is
        // stamped without having to be clicked first.
        vscode.commands.registerCommand('chutdown.refreshTabNames', () => {
            claude.sweepTabTitles('asked for').then((n) => {
                if (!n) vscode.window.setStatusBarMessage('Chutdown: every claude tab already named', 3000);
            }, (e) => shared.nlog('rename: sweep - ' + e.message));
        }),
        vscode.commands.registerCommand('chutdown.openUsagePage', () =>
            vscode.env.openExternal(vscode.Uri.parse('https://claude.ai/settings/usage'))),
        // Clicking the meter steps its number to the next limit - a weekly window that
        // is spent pins it to "0%" otherwise, hiding the limits that still have room.
        vscode.commands.registerCommand('chutdown.cycleUsageFocus', usage.cycleUsageFocus),
        vscode.window.onDidChangeActiveTerminal(() => claude.renameActiveClaude()),
        vscode.commands.registerCommand('chutdown.focusTerminal', (name) => {
            batch.toggleTerminal(name).catch(() => { });
        }),
        vscode.commands.registerCommand('chutdown.openTranscript', async (file) => {
            try {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch { /* transcript vanished */ }
        }),
        vscode.window.onDidStartTerminalShellExecution(batch.captureExecution),
        vscode.window.onDidEndTerminalShellExecution(batch.executionEnded),
        vscode.window.onDidCloseTerminal(batch.onTerminalClosed),
        // "claude" in the terminal panel's + dropdown, courtesy of a profile provider.
        vscode.window.registerTerminalProfileProvider('chutdown.claude', {
            provideTerminalProfile() {
                const root = shared.firstRoot();
                if (shared.cfg().get('openInEditorArea')) claude.settleIntoGroup(claude.activeViewColumn());
                const sh = platform.claudeProfile();   // cmd /k claude, or $SHELL -l -c claude
                return new vscode.TerminalProfile({
                    name: 'claude',
                    shellPath: sh.shellPath,
                    shellArgs: sh.shellArgs,
                    cwd: root,
                    iconPath: shared.claudeIcon(),   // the Chutdown "C" on the tab
                    location: claude.claudeLocation(),
                    env: { CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1' }
                });
            }
        }),
        vscode.window.onDidOpenTerminal((t) => {
            // Reload-survivors first: a restored terminal re-binds via its shell pid.
            claude.restoreBinding(t);
            // Terminals born from the + dropdown profile arrive here, not from newClaude().
            const o = t.creationOptions || {};
            if (platform.isClaudeProfileTerminal(o))
                claude.trackClaude(t, typeof o.cwd === 'object' && o.cwd ? o.cwd.fsPath : (o.cwd || shared.firstRoot()),
                    o.location === vscode.TerminalLocation.Editor ||
                    (o.location && typeof o.location === 'object' && 'viewColumn' in o.location));
        })
    );

    // Terminals restored by the window reload may already exist before the listener
    // above was registered - re-bind those now.
    claude.loadPendingBindings();
    // Sessions closed before the reload stay closed (they used to all come back white).
    shared.loadSuppressed();

    pollTimer = setInterval(() => { shutdown.tick().catch(() => { }); }, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
    // This window's line in the cross-window ledger the armed shutdown reads (shutdown.js):
    // taken down on the way out, so a window that closes cleanly stops counting at once
    // rather than after the staleness timeout.
    context.subscriptions.push({ dispose: () => shutdown.dropPeer() });
    // The poll is the backstop; transcript writes wake the scan straight away.
    context.subscriptions.push(shutdown.watchTranscripts());

    // The FIRST tick is deferred out of activate() rather than called from it. tick() is
    // async, but nothing in it awaits before the scan and the render, so calling it here
    // ran the whole first scan SYNCHRONOUSLY as part of activation - and the first scan
    // is not the cheap steady-state one: every session in the lookback window still has
    // to have its tail (256 KB) and its first prompt (64 KB) read, ~1,100 synchronous fs
    // calls and ~18 MB, none of it latched against an mtime yet. Warm that is most of a
    // second; against a COLD page cache - the first window after a boot, Defender reading
    // every transcript, the workbench restoring over the top of it - the same calls cost
    // ~50 ms each and activation was measured at 53.8 SECONDS, with the extension host
    // thread (shared with every other extension) blocked for all of it.
    //
    // Nothing about the work gets cheaper here; it just stops holding up activation and
    // everybody else's. The startup spinner already covers the gap - it is gated on the
    // first render, which is what this schedules.
    const firstTick = setTimeout(() => { shutdown.tick().catch(() => { }); }, 0);
    context.subscriptions.push({ dispose: () => clearTimeout(firstTick) });
}

function deactivate() {
    if (pollTimer) clearInterval(pollTimer);
    shutdown.dropPeer();   // stop blocking another window's armed shutdown
}

module.exports = { activate, deactivate };

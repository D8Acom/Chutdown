// Windows. The behaviour Chutdown shipped with, moved out of the modules that used
// to call it inline - nothing here changed, it just has a name now.

const cp = require('child_process');

const shared = require('../shared');
const log = (m) => shared.nlog('port: ' + m);

const execOpts = { windowsHide: true };

/// PlaySync in a throwaway PowerShell so the wav actually finishes before the process
/// exits (Play() would cut it off); a missing file falls back to the system sound.
function soundCommand(file, exists) {
    const quoted = "'" + file.replace(/'/g, "''") + "'";
    const script = exists
        ? '(New-Object Media.SoundPlayer ' + quoted + ').PlaySync()'
        : '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800';
    return 'powershell -NoProfile -Command "' + script + '"';
}

/// The OS-level popup for the 'notify' gear. This is deliberately NOT a VS Code
/// notification: the whole point is a popup you see with the editor minimised, or from
/// the other side of the room.
///
///   'dialog' (default)  a WScript.Shell Popup - MB_SYSTEMMODAL (0x1000) so it comes up
///                       ON TOP of whatever is focused, + the info icon (0x40) = 4160,
///                       and 0 seconds means it waits there until it is clicked. It
///                       cannot be swallowed by Focus Assist, which is why it is the
///                       default: a "you can come back now" popup that silently never
///                       appeared is worse than no popup at all.
///   'toast'             the quiet one: a real Windows toast that lands in the Action
///                       Center. Needs a REGISTERED AppID - PowerShell's own, which is
///                       in the Start menu on every stock install - and is suppressed by
///                       Do Not Disturb / Focus Assist, so a throw OR a missing WinRT
///                       falls back to the dialog rather than showing nothing.
function notifyCommand(title, message, style) {
    // Ours are the only strings that get here, but they carry session counts and the
    // workspace folder name, so: one line only, and nothing cmd.exe re-reads inside the
    // double quotes it wraps this in (%VAR% expansion, an early ").
    const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/["%^]/g, '').trim();
    const q = (s) => "'" + clean(s).replace(/'/g, "''") + "'";
    const t = q(title), m = q(message);
    const popup = '(New-Object -ComObject WScript.Shell).Popup(' + m + ',0,' + t + ',4160)|Out-Null';
    if (style !== 'toast') return 'powershell -NoProfile -Command "' + popup + '"';
    const APP_ID = "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'";
    const toast = [
        '[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]',
        '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
        '$n=$x.GetElementsByTagName(' + "'text'" + ')',
        '$n.Item(0).AppendChild($x.CreateTextNode(' + t + '))|Out-Null',
        '$n.Item(1).AppendChild($x.CreateTextNode(' + m + '))|Out-Null',
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + APP_ID + ').Show(' +
            '[Windows.UI.Notifications.ToastNotification]::new($x))',
        // The toast is handed to the notification platform asynchronously; a powershell
        // that exits the same instant can lose it.
        'Start-Sleep -Milliseconds 500'
    ].join('; ');
    return 'powershell -NoProfile -Command "try { ' + toast + ' } catch { ' + popup + ' }"';
}

/// The armed countdown as a desktop window - a real one, ticking every second, with a
/// Cancel button (src/countdown.ps1, which is where the WinForms lives). Handed a FILE
/// rather than an inline script: sixty lines of WinForms through cmd.exe's quoting would
/// be a bug farm, and -File takes its arguments as arguments.
///
/// THREE outcomes, and nonzero still means DO NOT power off by itself: exit 0 and nothing
/// printed is the countdown running out; nonzero carrying CHUTDOWN:NOW:<token> is the "do
/// it now" button; nonzero carrying CHUTDOWN:CANCEL:<token> is cancelled, closed or
/// Escape. Nonzero with NEITHER token is a window that never appeared - a missing
/// PowerShell, a blocked ExecutionPolicy, a script that would not parse - and must never
/// read as "the user let it run out" OR as "the user cancelled".
///
/// The token is what makes those two answers trustworthy. It is minted per launch by
/// shutdown.js and printed by exactly one line in countdown.ps1, so a process that failed
/// to start cannot counterfeit an answer the way it could counterfeit an exit code. It is
/// filtered to hex here so it can never introduce quoting of its own, and it is the LAST
/// argument and an optional one: a five-argument call emits no -Token at all and produces
/// a byte-identical command line to the one this shipped with.
const COUNTDOWN_SCRIPT = 'countdown.ps1';

function countdownCommand(script, title, message, action, seconds, token) {
    const q = (s) => '"' + String(s).replace(/[\r\n]+/g, ' ').replace(/["%^]/g, '') + '"';
    const tok = String(token || '').replace(/[^0-9a-f]/gi, '');   // hex or nothing
    return 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + q(script) +
        ' -Seconds ' + Math.max(1, Math.round(Number(seconds) || 0)) +
        ' -Title ' + q(title) + ' -Message ' + q(message) + ' -Action ' + q(action) +
        (tok ? ' -Token ' + tok : '');
}

function powerCommand(action, force) {
    const f = force ? ' /f' : '';
    switch (action) {
        case 'shutdown': return 'shutdown /s' + f + ' /t 0';
        case 'restart': return 'shutdown /r' + f + ' /t 0';
        case 'logoff': return 'shutdown /l';
        default: return '';
    }
}

/// The contract's "what would run, ignoring whether it can". On Windows there is no gap
/// between the two questions - shutdown.exe is present on every Windows there is, and the
/// user's own session is allowed to call it - so this is powerCommand itself. It exists
/// here so the suite can ask both platforms the same question; darwin.js is where the two
/// answers actually diverge, on a Linux box that systemd did not boot.
const powerCommandFor = powerCommand;

/// Nothing platform-specific to say about a power command that failed here, and nothing to
/// prime either: shutdown.exe is an ordinary program run by the user's own session, not an
/// Apple event a permission system can refuse. Both return '' - the contract for "there is
/// nothing of this kind here" - so shutdown.js never asks which OS it is on.
function powerHint() { return ''; }
function automationProbeCommand() { return ''; }

/// Every pid LISTENing on the port right now - including servers this window never
/// started (a leftover from a previous VS Code run, or your own external terminal).
function listeningPids(port) {
    return new Promise((resolve) => {
        // No "-p tcp": that misses a server bound only to IPv6 ([::1]:3003).
        // maxBuffer: the 1 MB default silently TRUNCATES netstat on a busy machine and
        // the truncated output is parsed anyway - a port that is genuinely held then
        // reads as free, and the dev server quietly moves to the next one.
        cp.exec('netstat -ano', Object.assign({ maxBuffer: 16 * 1024 * 1024 }, execOpts), (err, out) => {
            if (err) log('netstat: ' + err.message);
            const pids = new Set();
            for (const line of String(out || '').split('\n')) {
                // The STATE column is localized by Windows - "ABHÖREN" on a German
                // install, and matching the literal "LISTENING" found nothing there. A
                // listening socket is the one whose FOREIGN port is 0, in every
                // language: local addr:port, foreign addr:0, state (whatever it is
                // called), pid. Matched positionally instead of by an English word.
                const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(\S+):(\d+)\s+(\S+)\s+(\d+)\s*$/i);
                if (m && Number(m[2]) === port && Number(m[4]) === 0) pids.add(m[6]);
            }
            pids.delete('0');
            resolve([...pids]);
        });
    });
}

/// The kill as a STRING, so both platforms are asserted the same way - darwin's is a
/// recursive shell function and had no test at all while it was built inline. Behaviour
/// here is unchanged; /T is taskkill's own tree walk. '' for anything that is not a pid,
/// which is how killPid stays away from a command line with a stray argument in it.
function killTreeCommand(pid) {
    const n = Number(pid);
    return Number.isInteger(n) && n > 0 ? 'taskkill /PID ' + n + ' /T /F' : '';
}

function killPid(pid) {
    const cmd = killTreeCommand(pid);
    if (!cmd) return Promise.resolve();
    return new Promise((done) => cp.exec(cmd, execOpts, () => done()));
}

/// `cmd /k claude`: runs claude, and leaves a live prompt in the tab when it exits
/// rather than closing the terminal out from under you.
function claudeProfile() {
    return { shellPath: 'cmd.exe', shellArgs: ['/d', '/k', 'claude'] };
}

function isClaudeProfileTerminal(o) {
    return o.shellPath === 'cmd.exe' && Array.isArray(o.shellArgs) && o.shellArgs.includes('claude');
}

/// The process table - one row per process: pid, parent pid, and the moment it started
/// on this OS's own clock. This lived inline in identify.js behind two
/// `platform.id !== 'win32'` gates, which is the whole reason tab identification was a
/// Windows feature: not because the idea is one, but because the single OS call it needs
/// was written once and never given a second implementation. Every OS has that call -
/// Get-CimInstance here, `ps` on POSIX - so it belongs in the contract like the rest.
///
/// The argv is exposed on its own because it is PURE: the exact command can be pinned
/// from a machine that is not the one it runs on, which is how test/smoke.js checks it
/// at all. It is also the question identify.js asks in place of "which OS is this" -
/// null would mean "there is no way to list processes here", and the gate is then a
/// capability question that a future platform answers for itself. Windows always has one.
const PS_TABLE = 'Get-CimInstance Win32_Process | ForEach-Object { ' +
    '"$($_.ProcessId) $($_.ParentProcessId) ' +
    '$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })" }';

function processTableArgv() {
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_TABLE];
}

/// Never rejects - an empty Map is "could not read it", the same contract listeningPids
/// keeps, and identify.js already treats an empty table as nothing to do. A rejection
/// here would instead have to be caught by every caller to keep the `busy` latch from
/// sticking, which is exactly the kind of bookkeeping a promise that always resolves
/// removes. Both the throw from execFile itself (no PowerShell on PATH) and the 'error'
/// event that arrives later land on the same resolve.
///
/// maxBuffer is 8 MB because the 1 MB default silently TRUNCATES the listing on a busy
/// machine and the truncated text is parsed anyway - which reads as "that pid is not
/// running" and quietly unidentifies a tab. The 20s timeout is there so a wedged
/// PowerShell cannot latch identify.js's `busy` flag for the rest of the window's life.
///
/// `start` is OPAQUE to every caller: FILETIME ticks here, a ps lstart string on POSIX.
/// Only startMatches() below may interpret it.
function processTable() {
    return new Promise((resolve) => {
        const map = new Map();
        const argv = processTableArgv();
        let child;
        try {
            child = cp.execFile(argv[0], argv.slice(1),
                { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
                (err, stdout) => {
                    if (err && !stdout) { shared.nlog('identify: process table failed - ' + err.message); }
                    for (const line of String(stdout || '').split('\n')) {
                        const p = line.trim().split(/\s+/);
                        const pid = Number(p[0]);
                        if (!pid || p.length < 2) continue;
                        map.set(pid, { ppid: Number(p[1]) || 0, start: p[2] || '0' });
                    }
                    resolve(map);
                });
        } catch (e) {
            shared.nlog('identify: could not run powershell - ' + e.message);
            resolve(map);
            return;
        }
        if (child) child.on('error', () => resolve(map));
    });
}

/// Two processes can wear the same pid weeks apart, so a session file is trusted only
/// when the process it names STARTED when it says it did. `procStart` is written by
/// claude itself as a Windows FILETIME (100ns ticks since 1601) and the table above
/// hands back the same clock, so this is one subtraction. Same-second is close enough -
/// claude writes its file a moment after it is spawned.
///
/// The whole record is passed rather than one field, so each OS can read the field it
/// actually has. And the answer is TRUE wherever there is nothing to check with: a
/// platform with no opinion must never block a match, because the failure directions
/// are not symmetric - "no reuse check" costs a rare mis-identification that the
/// sessions-file match already makes unlikely, while "nothing ever matches" costs the
/// feature entirely and looks like a bug nobody can reproduce.
const START_TOLERANCE_TICKS = 5 * 10_000_000;   // 5s, in FILETIME ticks

function startMatches(rec, start) {
    if (!rec || !rec.procStart || !start || start === '0') return true;
    const a = Number(rec.procStart), b = Number(start);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return Math.abs(a - b) <= START_TOLERANCE_TICKS;
}

/// Windows has no store of Claude Code's making to read - the sign-in is the file
/// usage.js already reads. Present so usage.js never asks which OS it is on.
function keychainReadArgv() { return null; }
function readStoredCredentials() { return Promise.resolve({ creds: null, reason: 'unsupported' }); }

module.exports = {
    id: 'win32', name: 'Windows', execOpts, forceSupported: true,
    // Where the sound picker looks for the wavs this machine already has. %SystemRoot%
    // rather than a literal C:\Windows - a Windows installed on another drive is rare
    // but it is one environment variable to read, not a guess.
    systemSoundDir: require('path').join(process.env.SystemRoot || 'C:\\Windows', 'Media'),
    countdownScript: COUNTDOWN_SCRIPT,
    soundCommand, powerCommand, powerCommandFor, notifyCommand, countdownCommand, listeningPids, killPid, claudeProfile, isClaudeProfileTerminal,
    killTreeCommand, automationProbeCommand, powerHint, keychainReadArgv, readStoredCredentials,
    processTableArgv, processTable, startMatches
};

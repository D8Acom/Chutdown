// macOS. The same calls as win32.js, done the way this OS does them:
//
//   powershell PlaySync   ->  afplay          (both block until the sound ends)
//   WScript.Shell Popup   ->  osascript       (the 'notify' gear's OS-level popup)
//   shutdown /s /t 0      ->  osascript       (Apple events - no sudo, no password)
//   netstat -ano          ->  lsof            (asked per port, not scraped whole)
//   taskkill /PID /T /F   ->  a recursive pgrep -P walk, leaves first, parent last
//   cmd /d /k claude      ->  $SHELL -l -i -c 'claude; exec $SHELL -l'
//   (no Windows sibling)  ->  /usr/bin/security (the login Keychain, where macOS keeps
//                             the Claude Code sign-in that Windows keeps in a file)
//
// This module is also what index.js falls back to on any non-Windows platform, so it
// carries three columns rather than two: mac (isMac), the POSIX fallback Linux and the
// BSDs get (isPosix), and the degenerate case of this file being loaded on the Windows
// dev box by the test suite, where neither is true and nothing but the pure string
// builders should answer at all.
//
// The POSIX halves - lsof, pgrep, `ps`, the login-shell claude profile - are genuinely
// portable and are not guarded on isMac. What used to be guarded on nothing at all were
// afplay and osascript: Linux was handed commands naming binaries that are not there,
// and both callers swallow the resulting ENOENT into the output channel, so the chime
// gear and the popup gear sat in the status bar announcing they were armed and then did
// nothing whatsoever, five times a minute, in silence.
//
// Two different answers to that, and which one is right depends entirely on what a
// wrong guess costs:
//
//   a chime and a popup get a REAL Linux implementation - the paplay/pw-play/aplay
//   chain and the zenity/kdialog/xmessage/notify-send chains below. Every branch is
//   `command -v X && exec X`, so a tool that is not installed falls through instead of
//   failing, and the end of each chain is an `exit 127` with a named reason that
//   reaches the user through the callback that already exists. The worst a wrong guess
//   costs is one logged line saying which players were looked for.
//
//   powerCommand still returns '' on anything but a Mac, and that is not an oversight.
//   A power command guessed wrong does not cost a line in a channel: the gear tears the
//   user's dev servers down first and then runs nothing, so the cost of the guess is
//   their work. shutdown.js refuses to arm where powerCommand() is '' and says why at
//   the click, which is the honest answer until someone can test one.
//
// '' remains the contract for "this platform cannot do this", and every caller already
// understood it - shutdown.js has had `if (!cmd)` branches waiting for an answer this
// module never gave.

const cp = require('child_process');
const fs = require('fs');

const shared = require('../shared');

const execOpts = {};
const isMac = process.platform === 'darwin';

/// The third column, and it is load-bearing rather than a convenience alias for !isMac.
/// test/smoke.js loads this file unmodified on the Windows dev box - as the fallback
/// index.js hands to Linux - and also loads it a second time with process.platform
/// forced to 'darwin' to pin the mac strings. A branch written `if (!isMac)` would hand
/// the Windows run the Linux answers, so the suite would assert paplay and zenity on a
/// machine that is neither, and the two assertions that Linux commands are real would
/// pass without ever having looked at Linux.
const isPosix = process.platform !== 'win32' && !isMac;

// Linux specifically, where isPosix is not enough. The chime and the popup are the same
// on any desktop unix, but the POWER ACTION is not: systemctl and logind are systemd, and
// on a FreeBSD box - which is also isPosix - naming them would be exactly the failure this
// module was rewritten to stop making. So the countdown window is isPosix (zenity and
// kdialog are ports there), and everything that powers the machine off is isLinux.
const isLinux = process.platform === 'linux';

/// And isLinux is not enough EITHER, which is the second half of the same lesson.
///
/// Every Linux power verb this module knows is a request to logind - `systemctl poweroff`
/// and `loginctl terminate-session` both talk to systemd over D-Bus, which is exactly why
/// they need no sudo and no password. On a Linux box where systemd is not what booted the
/// machine there is nobody on the other end of that call: Devuan, Void, Alpine, Gentoo
/// with OpenRC, a docker container, and - the one that matters most here, because VS Code
/// runs the extension host inside it with process.platform === 'linux' - a WSL distro
/// without `systemd=true` in /etc/wsl.conf. `systemctl poweroff` there prints "System has
/// not been booted with systemd as init system (PID 1). Can't operate." and exits nonzero.
///
/// Returning the string anyway is not a harmless optimism, because powerAvailable() in
/// shutdown.js is `!!platform.powerCommand(action, force)` and nothing else. A non-empty
/// string is the extension's word that the action WILL run, and it is spent before the
/// action is tried: the gear arms, the countdown runs, batch.stopAll Ctrl+Cs every dev
/// server in the workspace, and only then does /bin/sh discover there is no systemd. The
/// workspace is torn down in exchange for nothing and the machine is still on - which is
/// the precise outcome '' exists to prevent, and the reason powerCommand answers '' on a
/// BSD rather than guessing a verb nobody here can test.
///
/// So the capability is asked, not assumed. stat("/run/systemd/system") is systemd's own
/// documented answer to "did systemd boot this machine" - it is what sd_booted(3) does,
/// and it is deliberately a different question from "is systemctl installed", which is
/// true on plenty of boxes where it cannot work. Asked once, at module load, because an
/// init system does not arrive halfway through a session.
function systemdBooted() {
    try { return fs.statSync('/run/systemd/system').isDirectory(); } catch (e) { return false; }
}

const hasLogind = isLinux && systemdBooted();

/// What the user is told this platform is called. `id` stays the raw process.platform,
/// because that is what code keys off; this is the half that appears in sentences, and
/// "no player on linux" reads like a bug report about someone else's machine.
const POSIX_NAMES = { linux: 'Linux', freebsd: 'FreeBSD' };

/// Single-quote for /bin/sh: everything is literal inside '...', and the only thing
/// that cannot appear there is a single quote, which is closed-escaped-reopened.
function shq(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/// afplay blocks until the sound finishes, which is what the chime wants (a player
/// that returned immediately would be killed with the shell). A missing file falls
/// back to a stock system sound, the counterpart of the Windows exclamation.
const SYSTEM_SOUND = '/System/Library/Sounds/Glass.aiff';

/// The Linux/BSD counterpart, and the same blocking requirement: every one of these
/// four plays in the foreground and returns when the sound ends. They are tried in the
/// order a desktop is likely to have them - PulseAudio, then PipeWire's own client,
/// then bare ALSA, then ffmpeg's player as the catch-all - and each branch is
/// `command -v X && exec X`, so a missing tool costs nothing but the next branch.
///
/// The last branch is the point of the whole shape: a box with no player at all exits
/// 127 with a sentence on stderr naming what was looked for, which playFile's existing
/// error callback already receives. Without it the chain would end in a shell that
/// exits 0 having played nothing, which is the silent no-op this file exists to stop.
///
/// `command -v` is only half a fall-through, and the missing half is what a player that
/// is INSTALLED AND CANNOT PLAY does. The commonest case is not hypothetical: the no-file
/// fallback below is .oga, because that is what a Linux desktop actually ships, and aplay
/// is ALSA's raw-audio player, which reads wav and au and cannot decode Ogg at all. On an
/// alsa-utils box with no PulseAudio and no PipeWire, `command -v aplay` hits, aplay exits
/// 1 on the file, and ffplay four characters later - installed, and able to play it - is
/// never reached. Every explicit pick has the same shape, since systemSoundDir on Linux is
/// /usr/share/sounds/freedesktop/stereo and its entire contents are .oga.
///
/// So the players run UNDER /bin/sh rather than replacing it, and only the last one execs.
/// The shell that survives a failing player is what evaluates the next `||`, which is the
/// fall-through the chain was always described as having. The cost is a chime that could
/// in principle play twice, if some player ever managed to play a sound through to the end
/// and then exit nonzero; the players that fail here fail before making any sound at all
/// (no server to connect to, or a format they cannot read), and a chime heard twice is a
/// nuisance where a chime never heard is the bug this whole chain exists to fix.
///
/// The popup chain below is the opposite trade and keeps its execs for that reason: a
/// CLOSED zenity exits 1 having done its job perfectly, so falling through there would put
/// a second dialog on screen. A dialog shown twice is not a nuisance, it is the gear
/// misbehaving.
///
/// ffplay keeps its `exec` because there is nothing after it but the message, and the
/// message must not claim nothing was found when ffplay was found and failed.
///
/// The no-file fallback is the freedesktop chime rather than Glass.aiff, which is not
/// on this OS at all.
const POSIX_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';

function soundCommand(file, exists) {
    if (isMac) return 'afplay ' + shq(exists ? file : SYSTEM_SOUND);
    if (!isPosix) return '';
    const f = shq(exists ? file : POSIX_SOUND);
    return '{ command -v paplay >/dev/null 2>&1 && paplay ' + f + '; } || ' +
        '{ command -v pw-play >/dev/null 2>&1 && pw-play ' + f + '; } || ' +
        '{ command -v aplay >/dev/null 2>&1 && aplay -q ' + f + '; } || ' +
        '{ command -v ffplay >/dev/null 2>&1 && exec ffplay -nodisp -autoexit -loglevel quiet ' + f + '; } || ' +
        "{ echo 'no audio player could play this file (tried paplay, pw-play, aplay, ffplay) - " +
        "install pulseaudio-utils, alsa-utils or ffmpeg' >&2; exit 127; }";
}

/// The OS-level popup for the 'notify' gear - osascript, the same way the power action
/// is done. Both styles are one AppleScript, single-quoted whole for /bin/sh:
///
///   'dialog' (default)  a real dialog that stays up until it is clicked. `tell me to
///                       activate` first, or the dialog comes up BEHIND whatever is in
///                       front - which is the one thing a come-back-now popup must not
///                       do. `me` is osascript itself: this used to be wrapped in `tell
///                       application "System Events"`, which made the popup that app's
///                       window, cost an Automation consent prompt for no benefit at
///                       all, and outlived any attempt to take it off the screen. Unlike
///                       a notification it cannot be swallowed by Do Not Disturb, which
///                       is why it is the default.
///   'toast'             the quiet one: a Notification Centre banner. Silently drops
///                       the message under Do Not Disturb, and (unlike the dialog) only
///                       appears if the user has allowed notifications for the app
///                       running osascript - Script Editor, or VS Code's own helper.
///
/// Linux and the BSDs get the same two styles out of whatever the desktop has, in the
/// order that best preserves what each style PROMISES rather than the order tools are
/// most common in:
///
///   'dialog'            must come up on top, wait to be clicked, and not be
///                       suppressible - so zenity --info, then kdialog --msgbox, then
///                       xmessage, all three of which block until the button is
///                       pressed. `notify-send -u critical` is last and is a deliberate
///                       degradation, not a peer: it neither blocks nor survives Do Not
///                       Disturb, and it is here only because a banner that appeared is
///                       worth more than a dialog that did not.
///   'toast'             notify-send first, since that IS the banner; the blocking
///                       tools follow as a fallback, which is the one thing macOS
///                       deliberately does not have - there a toast that Notification
///                       Centre swallowed is undetectable, so there is nothing to fall
///                       back FROM.
///
/// Both chains end in an `exit 127` naming the tools, so a bare box produces a line
/// through notifyNow's existing error callback rather than nothing at all.
function notifyCommand(title, message, style) {
    if (!isMac && !isPosix) return '';
    if (isMac) {
        // Ours are the only strings that get here, but they carry the workspace folder name:
        // one line, and AppleScript's own two string escapes done before shq wraps the lot.
        const as = (v) => '"' + String(v).replace(/[\r\n]+/g, ' ').replace(/([\\"])/g, '\\$1') + '"';
        const t = as(title), m = as(message);
        if (style === 'toast')
            return 'osascript -e ' + shq('display notification ' + m + ' with title ' + t);
        return 'osascript -e ' + shq('tell me to activate\n' +
            'display dialog ' + m + ' with title ' + t + ' buttons {"OK"} default button 1 with icon note');
    }
    // The same one-line treatment, then shq() for /bin/sh. --no-markup is the extra one
    // these need and the AppleScript does not: zenity reads its --text as Pango markup,
    // and the message carries a workspace folder name that is free to contain & or <,
    // either of which renders as nothing at all - or as an unclosed tag that eats the
    // rest of the sentence. kdialog and xmessage take theirs as plain text already.
    const one = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();
    const t = shq(one(title)), m = shq(one(message));
    const zen = '{ command -v zenity >/dev/null 2>&1 && exec zenity --info --no-markup --title=' + t +
        ' --text=' + m + '; } || ';
    const kde = '{ command -v kdialog >/dev/null 2>&1 && exec kdialog --title ' + t + ' --msgbox ' + m + '; } || ';
    const none = (tools) => "{ echo 'no desktop popup tool found (" + tools + ")' >&2; exit 127; }";
    if (style === 'toast')
        return '{ command -v notify-send >/dev/null 2>&1 && exec notify-send ' + t + ' ' + m + '; } || ' +
            zen + kde + none('notify-send, zenity or kdialog');
    return zen + kde +
        '{ command -v xmessage >/dev/null 2>&1 && exec xmessage -center -buttons OK ' + m + '; } || ' +
        '{ command -v notify-send >/dev/null 2>&1 && exec notify-send -u critical ' + t + ' ' + m + '; } || ' +
        none('zenity, kdialog, xmessage or notify-send');
}

/// The armed countdown as a desktop window, POSIX half - and unlike the AppleScript one
/// below it can TICK, because zenity --progress redraws. The work is in src/countdown.sh:
/// a feeder loop piped into a dialog does not survive being flattened into one shell line,
/// which is the same reason the Windows half is a .ps1 file and not a -Command string.
///
/// THREE outcomes, the same three the other two platforms answer with - see
/// src/platform/index.js. countdown.sh works for its "no window ever appeared" answer
/// rather than assuming it away: a dialog tool that cannot draw exits 1, which is also
/// what Cancel exits, and the two must not be confused - one leaves the gear armed and
/// the window latched off, the other disarms the gear.
function posixCountdown(script, title, message, action, seconds, token) {
    if (!script) return '';
    const one = (v) => String(v).replace(/[\r\n]+/g, ' ').trim();
    const secs = Math.max(1, Math.round(Number(seconds) || 0));
    const tok = String(token || '').replace(/[^0-9a-f]/gi, '');
    return 'sh ' + shq(script) +
        ' --seconds ' + secs +
        ' --title ' + shq(one(title)) +
        ' --message ' + shq(one(message)) +
        ' --action ' + shq(one(action)) +
        (tok ? ' --token ' + tok : '');
}

/// The armed countdown as a desktop window. AppleScript cannot RE-DRAW a dialog, so there
/// is no per-second tick here the way there is on Windows - what it has instead is
/// `giving up after`, which closes the dialog at exactly the moment the countdown ends.
///
/// `tell me to activate` and NOT `tell application "System Events"`, which is what this
/// used to be. Inside a tell block the dialog is a window of the TARGET application, and
/// System Events sits in its own modal run loop with no interest in whether the osascript
/// that asked for it is still alive - so killing the countdown from our side (the
/// notification's Cancel got there first) left an always-on-top window on screen counting
/// down to nothing, with both its buttons dead, for the whole remainder of the countdown.
/// The tell block also imposes AppleScript's default TWO-MINUTE Apple event timeout, which
/// applies only inside one: at the default countdownSeconds of 120 the deadline and the
/// timeout fire in the same instant, and above it osascript always errored at t=120 with
/// -1712 while the dialog stayed up. Owned by osascript, the window dies with the process,
/// there is no AE timeout at all, and the countdown needs no Automation consent.
///
/// THREE outcomes - see src/platform/index.js. Run out is the ONLY path that reaches the
/// end of the script, and the fallthrough is an error rather than a return: the old shape
/// tested "error only if the button was Cancel", so any button string that did not match -
/// a localisation, a rename, an `action` the escaping altered - fell out of the bottom at
/// exit 0, i.e. read as consent.
function countdownCommand(script, title, message, action, seconds, token) {
    if (isPosix) return posixCountdown(script, title, message, action, seconds, token);
    if (!isMac) return '';
    const as = (v) => '"' + String(v).replace(/[\r\n]+/g, ' ').replace(/([\\"])/g, '\\$1') + '"';
    const secs = Math.max(1, Math.round(Number(seconds) || 0));
    const tok = String(token || '').replace(/[^0-9a-f]/gi, '');
    const NOW = action + ' now';
    return 'osascript -e ' + shq(
        'tell me to activate\n' +
        'set r to display dialog ' + as(message + ' This machine runs ' + action + ' in ' + secs + ' seconds.') +
        ' with title ' + as(title) +
        ' buttons {"Cancel - stay on", ' + as(NOW) + '}' +
        ' default button 1 with icon caution giving up after ' + secs + '\n' +
        'if gave up of r is true then return\n' +
        'if button returned of r is ' + as(NOW) + ' then error ' + as('CHUTDOWN:NOW:' + tok) + ' number 3\n' +
        'error ' + as('CHUTDOWN:CANCEL:' + tok) + ' number 1');
}

/// Apple events, so the power action needs no sudo and no password. The trade-off is
/// that this is the POLITE shutdown: an app holding unsaved changes can put up a save
/// panel and stop it dead - the same thing the Windows action does without /f. macOS
/// has no `shutdown /f`, which is why `forceCloseApps` used to be accepted and then
/// ignored here.
///
/// It is not ignored any more. The setting's INTENT - do not let an app with unsaved
/// changes hold the machine up - does have a mac expression, and it is the sweep below:
/// ask the OS which apps are in front of the user, SIGTERM them, give them two seconds,
/// SIGKILL whatever is left, then send the power event. Every clause of it is
/// deliberate:
///
///   ONE Apple event, and only to ask for pids. Everything after that is POSIX signals,
///   which need consent from nobody. The obvious shape - tell each app to quit - is the
///   one to reject: it costs an Automation grant PER TARGET APP, i.e. a queue of
///   consent prompts nobody is awake to answer at 3am, each blocking for AppleScript's
///   two-minute timeout and each remembered as a denial once it times out, and each
///   app's save panel holding its own tell open on top of that.
///
///   `background only is false` rather than `visible is true`: an app that is hidden or
///   minimised blocks a shutdown exactly as hard as one in front. The predicate also
///   excludes Dock, SystemUIServer, NotificationCenter and loginwindow for free. Finder
///   is excluded by name - it never blocks, and it relaunches itself.
///
///   The walk up from $$ collects our own ancestry and skips it, whatever this editor
///   ships as (Code, Code - Insiders, VSCodium, Cursor). Killing it would take the
///   extension host - and therefore the rest of this shutdown - with it.
///
///   Joined to the power event with '; ' and NEVER '&&'. If any part of the sweep
///   fails, /bin/sh carries on to the power event and the behaviour degrades to exactly
///   today's polite shutdown. That is the whole safety argument for shipping a shell
///   string that cannot be run from the machines this is developed on.
///
/// 'logoff' gets NO sweep, mirroring Windows, where `shutdown /l` takes no /f either.
/// Linux powers off through logind, which is why this needs no sudo and no password: a
/// session that is ACTIVE and LOCAL is allowed to do it by the stock polkit rules, and
/// systemctl asks logind over D-Bus rather than being setuid anything. The two ways that
/// is not true are both worth knowing about and both land in linuxPowerHint - an SSH
/// session is not local, and a seat with another user logged in makes the request a
/// "challenge" that wants a password typed.
///
/// `-i` is the analogue of the Windows /f, and the closest thing here to the mac sweep
/// below: it ignores inhibitor locks, which is what a media player, an unsaved editor or
/// a running package manager takes out to say "not now". Without it those stop the
/// shutdown, which is the polite behaviour and the default.
///
/// Logging out has no inhibitor to ignore and no systemctl verb - it is the session that
/// ends, not the machine. XDG_SESSION_ID is what logind puts in the environment of every
/// process in the session; the fallback is by user, for a session id that was not
/// inherited (a multiplexer, a session older than the logind that knows about it).
///
/// This builds the STRING and nothing else. Whether the string is handed out at all is
/// powerCommand's question and it asks hasLogind first, so none of these verbs ever
/// reaches /bin/sh on a Linux box that systemd did not boot.
function linuxPower(action, force) {
    const ignore = force ? ' -i' : '';
    switch (action) {
        case 'shutdown': return 'systemctl poweroff' + ignore;
        case 'restart': return 'systemctl reboot' + ignore;
        case 'logoff': return 'loginctl terminate-session "${XDG_SESSION_ID:-}" || ' +
            'loginctl terminate-user "$(id -un)"';
        default: return '';
    }
}

/// polkit refuses in TEXT, not in a number - "Interactive authentication required." on
/// stderr with a plain exit 1, the same status everything else that goes wrong leaves. So
/// the text is the only thing that can tell the cases apart, which is the same reason the
/// mac hint below reads -1743 out of a string rather than matching an exit code.
function linuxPowerHint(stderr) {
    const s = String(stderr || '');
    if (/Interactive authentication required/i.test(s) || /"challenge"/.test(s))
        return 'polkit will not let this session power the machine off without someone typing a ' +
            'password - which is nobody, at the end of an unattended countdown. That is what a ' +
            'session that is not both LOCAL and ACTIVE gets: over SSH, or with another user logged ' +
            'in at the seat. Either arm it from the desktop session itself, or allow it outright ' +
            'with a rule for org.freedesktop.login1.power-off in /etc/polkit-1/rules.d/.';
    if (/not found|No such file or directory/i.test(s) && /systemctl|loginctl|busctl/i.test(s))
        return 'this machine has no systemd, and the Linux power action is systemctl. The sound, ' +
            'notify and countdown gears all still work - it is only the power action that has ' +
            'nothing to call here.';
    if (/Access denied|Permission denied|"na"/i.test(s))
        return 'logind refused the power action outright. In a container, or a VM with no logind ' +
            'seat, there is nothing to power off from the inside; on a real desktop session, check ' +
            'that systemd-logind is running.';
    return '';
}

const FORCE_QUIT =
    '_mine=" "; _p=$$; while [ "${_p:-0}" -gt 1 ]; do _mine="$_mine$_p "; ' +
    '_p=$(ps -o ppid= -p "$_p" 2>/dev/null | tr -d " "); done; ' +
    '_ids=$(osascript -e ' + shq('tell application "System Events" to get unix id of ' +
        '(every application process whose background only is false and name is not "Finder")') +
    ' 2>/dev/null | tr "," " "); ' +
    '_hit=""; for _i in $_ids; do case "$_mine" in *" $_i "*) ;; *) _hit="$_hit $_i";; esac; done; ' +
    'if [ -n "$_hit" ]; then kill -TERM $_hit 2>/dev/null; sleep 2; ' +
    'for _i in $_hit; do kill -0 "$_i" 2>/dev/null && kill -KILL "$_i" 2>/dev/null; done; fi';

/// WHAT would run, with no view on whether it CAN. The two questions are separate here in
/// a way they are not on Windows: the mac and BSD answers depend only on which module this
/// is, but the Linux answer depends on what booted the machine, which is a fact about the
/// box rather than about the platform. Keeping the string builder apart from the gate is
/// what lets the suite pin the exact verbs on a dev box that is neither platform - and it
/// keeps hasLogind honest by making the gate a single line that can be read at a glance,
/// rather than a condition threaded through a switch.
///
/// Nothing in the extension should call this to DECIDE anything. powerCommand is the one
/// that answers "will this work"; this one only answers "with what".
function powerCommandFor(action, force) {
    if (isLinux) return linuxPower(action, force);
    if (!isMac) return '';
    const tell = (verb) => 'osascript -e ' + shq('tell application "System Events" to ' + verb);
    const sweep = force ? FORCE_QUIT + '; ' : '';
    switch (action) {
        case 'shutdown': return sweep + tell('shut down');
        case 'restart': return sweep + tell('restart');
        case 'logoff': return tell('log out');
        default: return '';
    }
}

function powerCommand(action, force) {
    // The capability, then the string, and never the string alone - see hasLogind above.
    // A Linux box with no systemd as PID 1 has no power verb this module can name, and
    // that is the same answer a BSD gets and for the same reason.
    if (isLinux && !hasLogind) return '';
    return powerCommandFor(action, force);
}

/// The power action is an Apple event, and macOS gates those on an Automation grant that
/// is charged to VISUAL STUDIO CODE, not to osascript - the responsible process is
/// inherited across the fork, so the prompt reads "Visual Studio Code wants access to
/// control System Events" and one grant covers `shut down`, `restart` and `log out`
/// alike. Denied, osascript writes -1743 to stderr and exits 1 - the SAME status a
/// cancelled dialog leaves, which is why the TEXT is the only thing that can tell them
/// apart, and why shutdown.js asks here instead of matching a number itself.
function powerHint(stderr) {
    if (isLinux) return linuxPowerHint(stderr);
    if (!isMac) return '';
    const s = String(stderr || '');
    if (/\(-1743\)|Not authorized to send Apple events/.test(s))
        return 'macOS is blocking Visual Studio Code from controlling System Events. Open System Settings > ' +
            'Privacy & Security > Automation > Visual Studio Code and switch on System Events; if the switch ' +
            'is not listed, run  tccutil reset AppleEvents com.microsoft.VSCode  in a terminal, then arm again.';
    if (/\(-1712\)|AppleEvent timed out/.test(s))
        return 'the macOS permission prompt was never answered - arm Chutdown again to retry it.';
    return '';
}

/// A harmless Apple event, and a real one, so it raises the Automation consent prompt. Run
/// at ARM time and nowhere else: nothing else touches System Events until the power action
/// itself, i.e. at the end of an unattended countdown with nobody there to answer it.
/// Linux has no up-front consent grant to raise - polkit decides at the moment of the
/// call, which on an unattended machine is the worst possible moment. So the Linux probe
/// ASKS instead: CanPowerOff is a read-only logind method that answers "yes", "challenge"
/// (a password would be wanted), "no", or "na" (no logind at all), and only "yes" is an
/// answer that will still be true with nobody in the room. The answer is turned into an
/// exit status here rather than in shutdown.js, because the probe's contract is a command
/// that FAILS when the power action would - and the string is echoed to stderr on the way
/// out, so powerHint has something to match on.
///
/// The probe takes the ACTION, and on Linux that is not a formality. macOS ignores it
/// because one Automation grant covers `shut down`, `restart` and `log out` alike, so any
/// one Apple event raises the prompt for all three. logind authorises each verb
/// separately, and the three do not agree: powering the machine off and rebooting it are
/// org.freedesktop.login1.power-off and .reboot, which a session that is not both LOCAL
/// and ACTIVE only gets by challenge, while LOGGING OUT ends the caller's own session and
/// wants no power authorisation at all. Asking CanPowerOff for a configured `logoff` is
/// how the arm click came to warn "Chutdown will not be able to power this machine off"
/// on a shared workstation where the one action the user had chosen was the one that
/// worked - a control saying at the click what it cannot do, and getting it wrong. There
/// is nothing to ask about a log out, so nothing is asked.
function automationProbeCommand(action) {
    if (isMac) return 'osascript -e ' + shq('tell application "System Events" to count processes');
    if (isLinux) {
        if (action === 'logoff') return '';
        const method = action === 'restart' ? 'CanReboot' : 'CanPowerOff';
        return 'r=$(busctl --system call org.freedesktop.login1 /org/freedesktop/login1 ' +
            'org.freedesktop.login1.Manager ' + method + ' 2>&1); ' +
            'case "$r" in *yes*) exit 0 ;; *) printf "%s\\n" "$r" >&2; exit 1 ;; esac';
    }
    return '';
}

/// Every pid LISTENing on the port. lsof is asked about the one port rather than
/// scraped whole, and exits 1 when nothing matches - so the exit code is ignored and
/// only stdout is read. -nP keeps it from resolving names and service aliases, which
/// is both faster and stops :3000 coming back as "hbci".
function listeningPids(port) {
    return new Promise((resolve) => {
        // ss FIRST on Linux, and lsof only if it is not there: ss is iproute2, which is
        // on every Linux box, where lsof is a package that frequently is not installed -
        // and a port probe that cannot see the pid holding the port is a "restart" button
        // that silently does nothing. ss exits 0 with no rows when nothing is listening,
        // which is why the fallback is chained on a FAILURE of ss and not on empty output.
        const cmd = (isLinux ? 'ss -lntpH "sport = :' + Number(port) + '" 2>/dev/null || ' : '') +
            'lsof -nP -iTCP:' + Number(port) + ' -sTCP:LISTEN -t';
        cp.exec(cmd, execOpts, (err, out) => {
            // Exit 1 just means "no match", so only a real failure is worth a line.
            if (err && err.code !== 1) shared.nlog('port: lsof: ' + err.message);
            const pids = new Set();
            // ss:  LISTEN 0 511 *:3000 *:* users:(("node",pid=1234,fd=20))
            const re = /\bpid=(\d+)/g;
            let m;
            while ((m = re.exec(String(out || '')))) if (m[1] !== '0') pids.add(m[1]);
            // lsof -t: one bare pid per line, and nothing that looks like ss's output.
            if (!pids.size) for (const line of String(out || '').split('\n')) {
                const pid = line.trim();
                if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
            }
            resolve([...pids]);
        });
    });
}

/// taskkill's /T (kill the tree) has no single-command equivalent, and `pkill -P` is not
/// it: that takes DIRECT children only, so `npm run dev` -> concurrently -> next dev left
/// the actual server alive holding the port.
///
/// A process GROUP kill is not the answer either, and is the dangerous shape here: node
/// only puts a child in its own group when spawned `detached`, and nothing in this repo
/// is - so our /bin/sh sits in the EXTENSION HOST's process group and `kill -9 -<pgid>`
/// would take VS Code's extension host down with the server. For the same reason the pid
/// itself is checked before the string is built at all: `kill -9 0` signals every process
/// in the caller's group, which is that same group.
///
/// So: a recursive leaf-first walk. SIGSTOP the parent first, so a supervisor (npm,
/// concurrently, nodemon) cannot fork a replacement while the walk is in progress;
/// descendants are then found and killed before the parent, so nothing is reparented to
/// launchd and escapes. SIGKILL is delivered fine to a stopped process.
function killTreeCommand(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 1 || n === process.pid || n === process.ppid) return '';
    return '_ck(){ kill -STOP "$1" 2>/dev/null; for c in $(pgrep -P "$1" 2>/dev/null); do _ck "$c"; done; ' +
        'kill -9 "$1" 2>/dev/null; }; _ck ' + n;
}

function killPid(pid) {
    const cmd = killTreeCommand(pid);
    if (!cmd) return Promise.resolve();
    return new Promise((done) => cp.exec(cmd, execOpts, () => done()));
}

function loginShell() {
    return process.env.SHELL || '/bin/zsh';
}

/// The `cmd /k` equivalent: run claude, and when it exits replace it with a fresh
/// login shell so the tab stays usable instead of closing itself.
///
/// `-i` as well as `-l`, and it is not cosmetic: `zsh -l -c` is a LOGIN, NON-INTERACTIVE
/// shell, and zsh reads ~/.zshrc only when interactive. Both common ways of getting
/// `claude` on a Mac put it on PATH from there - the native installer appends
/// `export PATH="$HOME/.local/bin:$PATH"` to the rc file, and an nvm-based install depends
/// on nvm's own ~/.zshrc block - so the + dropdown's profile opened, printed
/// "command not found: claude", and dropped to a shell where typing `claude` worked fine.
/// (Homebrew is the exception, which is why this looks like it works on some Macs.) bash
/// has the same shape of problem with ~/.bashrc; fish is unaffected and accepts -i anyway.
/// The shell has a real pty here, so interactive is the honest description of it.
function claudeProfile() {
    const sh = loginShell();
    return { shellPath: sh, shellArgs: ['-l', '-i', '-c', 'claude; exec ' + shq(sh) + ' -l'] };
}

function isClaudeProfileTerminal(o) {
    return Array.isArray(o.shellArgs) && o.shellArgs.some((a) => /^\s*claude(\s|;|$)/.test(String(a)));
}

/// The process table identify.js walks to work out which session a tab is running. It
/// used to be a PowerShell listing written inline there behind an `id !== 'win32'`
/// gate, which is why that feature was Windows-only - not because the idea is, but
/// because nobody had written the second implementation. `ps` yields the same three
/// columns, and it belongs with lsof, pgrep and claudeProfile in the portable half of
/// this file rather than behind isMac.
///
/// The argv is pure, so the exact command can be pinned from a machine that is not the
/// one it runs on, and it doubles as the capability question identify.js asks in place
/// of "which OS is this" - null would mean "there is no way to list processes here".
/// Neither of these platforms answers null today.
///
/// Do not tidy the flags. -A rather than -e: BSD ps historically read -e as "also show
/// the environment", and -A is the POSIX spelling procps accepts as well. -ww is
/// insurance against BSD ps clamping each row to 79 columns when stdout is a pipe. The
/// trailing '=' on each keyword is what suppresses the header. lstart is LAST because
/// it is the only field with spaces in it.
function processTableArgv() {
    return ['ps', '-A', '-ww', '-o', 'pid=,ppid=,lstart='];
}

/// Never rejects - an empty Map is "could not read it", the same contract listeningPids
/// keeps, and identify.js already treats an empty table as nothing to do.
///
/// LC_ALL=C and TZ=UTC are MANDATORY rather than tidiness. lstart is rendered through
/// strftime in the local time zone and the local locale, and claude records its own
/// procStart under exactly LC_ALL=C and TZ=UTC - so without this env every string here
/// differs from the recorded one, in the month name, in the offset, or in both, and
/// startMatches() would reject every live process it was asked about.
///
/// The parse is a regex and NEVER a /\s+/ split: a single-digit day prints as
/// "Tue Aug  9 07:06:04 2026", with two spaces, which a split turns into a different
/// number of fields for one process in thirty. `(.*\S)` takes the remainder of the line
/// verbatim, right-trimmed, and hands it on as an opaque string.
///
/// The cost, so nobody is tempted to relax identify.js's backoff on the strength of it:
/// one fork/exec of /bin/ps is a single sysctl and low tens of milliseconds, against
/// several hundred for PowerShell; 400-700 rows at about 45 bytes each is 20-30 KB
/// against an 8 MB buffer; and ps needs no TCC grant, so it can raise no consent
/// prompt. The 20s timeout is generous rather than tight now, and still has a job - a
/// ps wedged on an unresponsive filesystem must not latch `busy` for ever.
function processTable() {
    return new Promise((resolve) => {
        const map = new Map();
        const argv = processTableArgv();
        let child;
        try {
            child = cp.execFile(argv[0], argv.slice(1),
                {
                    env: Object.assign({}, process.env, { LC_ALL: 'C', TZ: 'UTC' }),
                    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 20_000
                },
                (err, stdout) => {
                    if (err && !stdout) { shared.nlog('identify: process table failed - ' + err.message); }
                    for (const line of String(stdout || '').split('\n')) {
                        const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)/.exec(line);
                        if (!m) continue;
                        const pid = Number(m[1]);
                        if (!pid) continue;
                        map.set(pid, { ppid: Number(m[2]) || 0, start: m[3] });
                    }
                    resolve(map);
                });
        } catch (e) {
            shared.nlog('identify: could not run ps - ' + e.message);
            resolve(map);
            return;
        }
        if (child) child.on('error', () => resolve(map));
    });
}

/// A ctime string - "Tue Aug  9 07:06:04 2026" - as a UTC millisecond count, parsed by
/// hand. Date.parse() reads that format as LOCAL time in V8, which is the one wrong
/// answer available here: processTable() asks ps for it under TZ=UTC, so reading it back
/// through the extension host's own zone shifts every process by the offset and turns a
/// perfectly good match into a rejection everywhere but Greenwich in winter.
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function lstartMs(s) {
    const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(String(s || '').trim());
    if (!m || !(m[1] in MONTHS)) return NaN;
    return Date.UTC(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/// Has the pid this session record names been RECYCLED - handed to some other process
/// since the file was written? Two processes can wear the same pid weeks apart, and a
/// session file outlives the claude that wrote it.
///
/// String equality first, because that is claude's own comparator on POSIX: it records
/// the lstart line verbatim and compares it verbatim, so an exact match is the answer
/// with no date arithmetic in it at all. The numeric paths below are the fallbacks for a
/// record written by an older build, or under a ps whose spacing differs.
///
/// Every branch that cannot form an opinion returns TRUE, and that direction is the
/// whole point rather than laziness. If the date-format guess in lstartMs is wrong on
/// some platform nobody here can test, identification degrades to the sessions-file
/// match alone - weaker, and correct in practice, since the pid still has to be live and
/// the cwd still has to be under this workspace. The alternative failure - returning
/// false when the format is not understood - is a feature that silently never matches
/// anything, on a platform where nobody can see why.
///
/// The window is 60s and not the 5s Windows uses. `startedAt` is Date.now() at the
/// moment the record was created and lstart is when the process began, so they are two
/// different clocks measuring two different instants; the only job here is rejecting a
/// pid recycled hours or days later, and a wide window costs nothing while removing any
/// chance that a slow node boot reads as a recycled pid. Windows keeps its 5s FILETIME
/// tolerance, where both numbers come off the same clock.
function startMatches(rec, start) {
    if (!rec || !start) return true;
    if (rec.procStart && String(rec.procStart).trim() === String(start).trim()) return true;
    const b = lstartMs(start);
    if (!Number.isFinite(b)) return true;              // nothing to check with
    const started = Number(rec.startedAt);
    if (Number.isFinite(started)) return Math.abs(started - b) <= 60_000;
    const a = lstartMs(rec.procStart);
    return Number.isFinite(a) ? Math.abs(a - b) <= 60_000 : true;
}

/// macOS keeps Claude Code's sign-in in the login Keychain, not in a file, so on a default
/// Mac install there is no .credentials.json at all - which is the whole reason the usage
/// meter came up blank there and nowhere else. /usr/bin/security prints the same JSON blob
/// the file holds, on one line, so the parsed result goes straight to the existing
/// consumers unchanged.
///
/// The permission question, answered: normally there is NO prompt, because the item's
/// access list trusts /usr/bin/security itself rather than the process that invoked it -
/// the Security Server gates on that binary, so a shell-out from the extension host
/// presents as the same trusted reader Claude Code uses. Normally, not always: a
/// partition-list bug in some builds pins the item to a team id and produces a repeating
/// password prompt that "Always Allow" silently cannot settle, and on macOS 26 the tool
/// can HANG on a SecurityAgent dialog that never appears. That is why usage.js calls this
/// only when the user has switched chutdown.usageKeychain on, and why this is execFile
/// with a hard timeout and a SIGKILL - never execSync, and never on the activation path:
/// the extension host is one thread shared with everything else in the window.
///
/// The blob carries a REFRESH token as well as an access one. It is parsed and handed
/// back, and nothing here logs it, writes it, or lets any part of it into a message.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function keychainReadArgv() {
    // Queried by SERVICE only. The account is the macOS $USER on the builds documented,
    // but service-only matching is robust to that varying.
    return isMac ? ['/usr/bin/security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'] : null;
}

function readStoredCredentials() {
    const argv = keychainReadArgv();
    if (!argv) return Promise.resolve({ creds: null, reason: 'unsupported' });
    return new Promise((resolve) => {
        cp.execFile(argv[0], argv.slice(1),
            { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 256 * 1024 },
            (e, stdout) => {
                if (e) {
                    // Killed with no status is the hang: the dialog never appeared.
                    if (e.killed || e.signal) return resolve({ creds: null, reason: 'timeout' });
                    const code = Number(e.code);
                    return resolve({ creds: null, reason:
                        code === 44 ? 'notfound' :          // errSecItemNotFound - never signed in
                        code === 36 ? 'nogui' :             // errSecInteractionNotAllowed - SSH, no session
                        (code === 51 || code === 128) ? 'denied' : 'failed' });
                }
                let parsed = null;
                try { parsed = JSON.parse(String(stdout || '').trim()); } catch { /* not ours */ }
                if (!parsed || typeof parsed !== 'object') return resolve({ creds: null, reason: 'failed' });
                resolve({ creds: parsed, reason: '' });
            });
    });
}

/// Where the sound picker looks for the sounds this machine already has: the stock macOS
/// alert sounds, or on Linux the freedesktop set every desktop ships, whichever of the
/// three usual locations exists. This stays a plain STRING and not a function because
/// pickSound and the picker read it as one, so the three stat calls happen once at module
/// load, on the activation path - cheap enough, and the alternative is stat-ing on every
/// keystroke in the picker instead. If none of the three is there the last one is used
/// anyway, so listDir's existing ENOENT swallow leaves the picker with the bundled chimes
/// and Browse, exactly as it was.
const POSIX_SOUND_DIRS = [
    '/usr/share/sounds/freedesktop/stereo',
    '/usr/share/sounds/gnome/default/alerts',
    '/usr/share/sounds'
];

function posixSoundDir() {
    for (const d of POSIX_SOUND_DIRS) {
        try { if (fs.statSync(d).isDirectory()) return d; } catch { /* try the next one */ }
    }
    return POSIX_SOUND_DIRS[POSIX_SOUND_DIRS.length - 1];
}

module.exports = {
    id: isMac ? 'darwin' : process.platform,
    // `id` is what code keys off and stays the raw platform; this is the half that ends
    // up in sentences the user reads, where "no player on linux" looks like a bug report
    // about somebody else's machine.
    name: isMac ? 'macOS' : (POSIX_NAMES[process.platform] || process.platform),
    execOpts,
    // What `forceCloseApps` does here is the quit sweep in powerCommand above on a Mac,
    // and `systemctl -i` on Linux - ignore the inhibitor locks an unsaved editor or a
    // running package manager took out. Both are real actions with a real cost. Nothing
    // else this module stands in for has a power command to force at all - which now
    // includes a Linux box with no systemd as PID 1, where there is no power command to
    // hang an -i on, so the setting would be accepted and then ignored.
    forceSupported: isMac || hasLogind,
    systemSoundDir: isPosix ? posixSoundDir() : '/System/Library/Sounds',
    // The countdown window's script, for the platforms whose window is one: zenity is
    // driven by src/countdown.sh, while the mac window is AppleScript built inline and
    // wants no file at all.
    countdownScript: isPosix ? 'countdown.sh' : '',
    soundCommand, powerCommand, powerCommandFor, notifyCommand, countdownCommand, listeningPids, killPid, claudeProfile, isClaudeProfileTerminal,
    killTreeCommand, automationProbeCommand, powerHint, keychainReadArgv, readStoredCredentials,
    processTableArgv, processTable, startMatches,
    // Not part of the contract in index.js - these two are the Linux power action's two
    // halves, exported apart so both can be checked from a dev box that is not Linux.
    // `linuxPowerCommand` is the pure string builder, so `systemctl poweroff` can be
    // pinned exactly; `systemdBooted` is the capability powerCommand asks BEFORE it hands
    // that string out. Pinning only the string is how a command that can never run ships
    // as an available one, which is the bug the gate above exists to close.
    linuxPowerCommand: linuxPower, systemdBooted: hasLogind
};

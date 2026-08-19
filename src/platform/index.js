// The one place that knows which OS this is.
//
// Everything Chutdown does that is not pure VS Code API - playing a sound, powering
// the machine down, finding and killing whatever holds a port, spawning a shell that
// runs `claude` - is an OS call, and each of those used to sit inline in the module
// that needed it (a `powershell -NoProfile` here, a `taskkill /T /F` there, a literal
// 'cmd.exe' in the terminal profile). That is why the extension was Windows-only: not
// because the ideas are, but because the four calls were hard-coded.
//
// So those calls live behind one small contract, implemented once per OS:
//
//   id                          'win32' | 'darwin' | 'linux', or the raw process.platform
//                               on anything else, which is what code keys off
//   name                        for messages the user reads - the name the OS is called
//                               by ('Linux', 'FreeBSD'), never the raw process.platform,
//                               which reads as somebody else's bug report in a sentence
//   execOpts                    child_process options (windowsHide on Windows)
//   soundCommand(file, exists)  a command that plays `file` and BLOCKS until it ends,
//                               or a system sound when exists is false
//   powerCommand(action, force) shutdown | restart | logoff -> a command, '' if none.
//                               '' is the extension's word that the action CANNOT run
//                               here, and powerAvailable() in shutdown.js is nothing but
//                               a test of this - so it must never answer with a string
//                               the box cannot honour.
//   powerCommandFor(a, force)   the same verb WITHOUT that capability check: what would
//                               run, as against whether it can. Identical to powerCommand
//                               on Windows and macOS, where the two questions have the
//                               same answer. They come apart on Linux, where the verb is
//                               `systemctl poweroff` on every box but only works on one
//                               systemd booted - so powerCommand answers '' there while
//                               this still names the verb. Nothing should DECIDE on this;
//                               it exists so the strings stay pinnable on a dev box that
//                               is neither platform, and so the gate is one readable line.
//   countdownScript             the file countdownCommand wants handed to it, relative
//                               to src/ - '' for a platform that builds its window inline
//   countdownCommand(script, title, message, action, seconds, token)
//                               a command that shows the armed countdown as a DESKTOP
//                               window. THREE outcomes, identical on every platform:
//                               exit 0 and nothing printed = the countdown ran out;
//                               NONZERO carrying CHUTDOWN:NOW:<token> = the user pressed
//                               "<action> now"; NONZERO carrying CHUTDOWN:CANCEL:<token>
//                               = the user cancelled. Nonzero with NEITHER token is a
//                               window that never appeared, and the machine stays on.
//                               `token` is minted per launch by shutdown.js and printed
//                               by exactly one line in the child, so a process that
//                               failed to start cannot counterfeit an answer the way it
//                               could counterfeit an exit code.
//   systemSoundDir              folder of sounds this machine already has, offered in the
//                               chime picker (C:\Windows\Media, /System/…/Sounds, and on
//                               Linux whichever of the usual /usr/share/sounds trees is
//                               there). A plain string, because the picker reads it as one
//   notifyCommand(t, m, style)  a command that puts an OS-LEVEL popup on screen (the
//                               'notify' gear): style 'dialog' waits to be clicked and
//                               cannot be suppressed, 'toast' is the quiet banner
//   forceSupported              does `forceCloseApps` do anything here, and it is a
//                               different thing per OS: /f on the Windows command, and on
//                               macOS a bounded quit sweep prepended to the power event
//                               (SIGTERM to every app with a Dock icon, then SIGKILL to
//                               whatever is still up two seconds later, this editor
//                               excluded). False where the setting would be accepted and
//                               then ignored, which shutdown.js says out loud.
//   listeningPids(port)         Promise<string[]> - every pid LISTENing on the port
//   killPid(pid)                Promise - force-kill it and its children
//   claudeProfile(cwd)          { shellPath, shellArgs } for the + dropdown profile
//   isClaudeProfileTerminal(o)  is this terminal's creationOptions one of ours
//   killTreeCommand(pid)        the tree kill as a STRING, so it is testable. '' for a
//                               pid that is not one, which is how killPid stays away
//                               from `kill -9 0` (the ext host's own process group).
//   automationProbeCommand()    a harmless command that raises this OS's "control other
//                               apps" consent prompt, run at ARM time so the prompt
//                               appears while the user's hand is still on the toggle
//                               rather than at the end of an unattended countdown. ''
//                               where there is no such consent.
//   powerHint(stderr)           one sentence naming an OS-specific reason the power
//                               command failed, shown to the user verbatim. '' if none.
//   keychainReadArgv()          the exact argv the OS credential store is read with, or
//                               null where there is none to read.
//   readStoredCredentials()     Promise<{creds, reason}> - the OS credential store's copy
//                               of Claude Code's sign-in blob. Never rejects. reason is
//                               one of 'unsupported' 'notfound' 'nogui' 'denied'
//                               'timeout' 'failed', and '' when creds is non-null.
//   processTableArgv()          the exact argv the process table is listed with, or null
//                               where there is no way to list it - which is the gate
//                               identify.js uses instead of asking which OS this is.
//   processTable()              Promise<Map<pid,{ppid,start}>> of every process. Never
//                               rejects; an empty Map is "could not read it". `start` is
//                               opaque - a FILETIME on Windows, a ps lstart string on
//                               POSIX - and only startMatches() may interpret it.
//   startMatches(rec, start)    is the live process at rec.pid the one the session file
//                               was written for, i.e. has the pid NOT been recycled.
//                               true where this OS has nothing to check with.
//
// TWO implementations and three columns, which is the thing to know before going looking
// for a third file: win32.js owns process.platform === 'win32', and darwin.js owns
// everything else. There is no linux.js. Linux is a column INSIDE darwin.js, behind an
// isLinux gate, alongside the mac column (isMac) and the portable POSIX one (isPosix) -
// the split is by what each OS call costs to guess wrong, not by file.
//
// Anything ELSE - a BSD, a Solaris, whatever runs VS Code next - also gets darwin.js,
// which is the only module that gates each OS call on the platform it belongs to rather
// than assuming it. What that fallback answers is split by what a wrong guess would
// cost. The portable half is unconditional and real everywhere: lsof, pgrep, `ps` for
// the process table, the login-shell claude profile, and the audio and popup chains,
// each of which is a `command -v X && exec X` list that falls through to the next tool
// and ends by naming what it looked for. The mac-only half - `afplay`, and every
// osascript, which is the power command, the countdown window and the Automation probe -
// answers '' there, the contract for "this platform cannot do this", because a power
// command guessed wrong does not cost a line in the output channel: shutdown.js tears
// the workspace's servers down before it runs one. shutdown.js refuses to arm where
// powerCommand() is '' and says so at the click.
//
// Linux is the platform that fallback answers for most completely: isLinux inside
// darwin.js is what `systemctl poweroff`, the logind Automation probe and the ss port
// probe hang off, and src/countdown.sh is the countdown window every isPosix box gets.
// A BSD still gets everything except the power action, which is the honest answer there.
//
// The Linux power action is gated a second time, on a capability rather than on the OS.
// Every verb it knows is a request to logind, so a Linux box that systemd did not boot -
// Devuan, Alpine, a container, a WSL distro without systemd=true, all of which report
// process.platform === 'linux' - has nothing to answer it, and powerCommand returns ''
// there exactly as it does on a BSD. That distinction has to be made HERE and not at the
// moment of the call, because shutdown.js spends a non-empty string long before it runs
// one: it is what the gear arms on and what batch.stopAll takes as permission to Ctrl+C
// every dev server in the workspace.

const win32 = require('./win32');
const darwin = require('./darwin');

module.exports = process.platform === 'win32' ? win32 : darwin;

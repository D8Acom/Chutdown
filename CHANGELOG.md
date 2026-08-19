# Changelog

All notable changes to Chutdown are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **The sample `.terminals` now tells an agent how to reset a server, in those words.** The
  restart link was in there, but as a single parenthetical at the end of one long note —
  `also /start and /stop, add &name=web for just one` — written for someone who already knew
  what it was for. The file's most frequent reader is the agent working in the repo, and its
  default move when told to bounce a dev server is to kill the process and run the command
  again in a shell of its own: a server outside the editor's terminals, with no tab, no light,
  no log in the hover, gone the moment that session ends. So the notes now say not to do that,
  give the one line that replaces it (`/restart?name=web&ws=…`, this folder already filled in),
  and take a line each for the two things that are not guessable — `name=` is a key from this
  same file, `ws=` is what stops the link landing in whatever window was last active — plus
  where the failures go, since the command itself prints nothing either way. Still strict JSON,
  still launches nothing as written.
- **A fresh window now names every claude tab, instead of one per click.** A rename can only
  ever land on the ACTIVE terminal, so at startup the only tab that got its session's word was
  whichever one the window restored in front — the rest sat as `claude`, or as `bash` once the
  relaunched shell wrote over them, until you clicked each one. The flick-through that put the
  names back after a full quit only ever covered tabs revived by slot pairing; the two other
  ways a tab gets bound at startup — a pid re-attached after a reload, and a tab claude's own
  pid files identified — both left it bound but unstamped. That flick is now a general sweep,
  run once after everything that can be bound is bound: every bound tab NOT already wearing its
  session's title is revealed in turn (focus is never taken), renamed, and the tab you were
  looking at goes back in front. A window with nothing to fix reveals nothing, so there is no
  flicker for its own sake, and a reveal that does not take is skipped rather than stamped —
  that is how a title used to land on the neighbouring tab. **Chutdown: Put Session Names Back
  On The Tabs** runs the same sweep on demand, for a background tab whose light has moved on.
- **A tab whose word is already taken now takes another word from its OWN prompt, not a
  digit.** The placeholder only ever used one word of the question — the longest early
  survivor — and a second tab wanting it got `review2`. Two tabs one digit apart are
  exactly the pair that gets misread at a glance, and the digit says nothing about the
  task, while the rest of the prompt was sitting there unused. The scan now ranks every
  distinctive word of the first prompt (longest first, earliest on ties, stopwords out,
  repeats collapsed); the leader is still the placeholder, and a collision walks down the
  list before it reaches for a counter — so "rewrite the parser so it keeps comments"
  lands on `comments` when `parser` is worn. The same list backs the AI namer, for the
  times a small model hands back one of the taken names it was told to avoid, and the
  dedupe sweep after each scan. Two things deliberately keep the counter: a word somebody
  CHOSE (typed in the hover, `/rename`d in the CLI, or picked by the verifier — that word
  was picked for this task, so replacing it is not deduplication), and a prompt with no
  free word left in it. The sweep's replacement is also checked against every name in
  play rather than only the ones it has already walked past — free with a counter, which
  nothing else is ever called, but not with a real word, which the tab two rows down may
  well be wearing.
- **The gear toggle is now `Status`, and names the action rather than the state.**
  `Shutdown: ARMED` read as a thing being loaded without saying which thing, next to an
  item already called Shutdown. It is now `Status: off / sound / notify / shutdown`, with
  the armed gear wearing whatever `chutdown.action` is — so `Status: test` is honest about
  a gear that only shows a message, where "shutdown" over the top of it would not be.

### Fixed
- **The countdown window's "shutdown now" button did nothing.** It reported itself with
  the same answer the run-out path used, and the extension threw that answer away
  entirely, so the button was inert on both platforms — you pressed it and watched the
  rest of the clock anyway. It now skips the rest of the **wait** and nothing else: the
  countdown breaks out of its loop and rejoins the ordinary path at the same line, so the
  full "is everyone still finished" re-check and the `.terminals` Ctrl+C still happen, and
  a session that started working again in that same second still stops the shutdown. The
  button is labelled with the action, so on `restart` it reads *restart now*.

- **A countdown window that never appeared read as "you pressed Cancel", and disarmed the
  gear.** Cancelled and never-launched were the same answer — a nonzero exit — so a
  missing PowerShell, a blocked ExecutionPolicy or an `osascript` that fell over told you
  *"Chutdown cancelled from the countdown window, and disarmed"* about a window you never
  saw, and quietly turned the gear off. The two are now told apart by a random token
  minted milliseconds before the launch and printed back by the window itself
  (`CHUTDOWN:NOW:` / `CHUTDOWN:CANCEL:`, on stdout from PowerShell and as the AppleScript
  error message on macOS) — an exit code is provenance-free and *now* is the answer that
  shortens the wait, so it had better be one nothing but the window can give. Both
  meaningful answers are carved out of the already-safe nonzero branch, never out of the
  run-out branch. A window that cannot be shown now says so, leaves the gear **armed**,
  and is not tried again this session; the next run counts down in the VS Code
  notification alone.

- **The macOS countdown dialog outlived the countdown, and timed out at exactly the
  default `countdownSeconds`.** It was built inside `tell application "System Events"`,
  which made it that app's window: killing our own `osascript` did not take it off the
  screen, so calling the shutdown off from the notification left an always-on-top window
  counting down to nothing with both buttons dead. The same `tell` block imposes
  AppleScript's two-minute Apple event timeout — at `countdownSeconds: 120` the deadline
  and the timeout fire in the same instant, and above it `osascript` errored at t=120 with
  `-1712` while the dialog stayed up. It is now `tell me to activate` and a bare `display
  dialog`: the window belongs to `osascript`, dies with the process, has no Apple event
  timeout at all, and needs no Automation consent. The `notify` gear's `dialog` popup had
  the same wrapper, for the same cost, and lost it too.

- **On macOS, any button the script did not recognise read as consent.** The old shape
  raised an error only when the button was *Cancel*, so a localisation, a rename or an
  `action` string the escaping altered fell out of the bottom of the script at exit 0 —
  which is "the countdown ran out", i.e. power the machine off. Running out is now the
  only path that reaches the end of the script, and the fallthrough is a cancel.

- **The usage meter could never work on macOS.** There is no `.credentials.json` there at
  all — macOS keeps the Claude Code sign-in as a login Keychain item — so every poll found
  no token, took the generic "no sign-in" path, and doubled its backoff to the 30-minute
  cap for ever, with the plan line gone from the hover and nothing anywhere naming the
  reason. The meter now paints from Claude Code's own cached reading in `~/.claude.json`
  (no token, no network, on every platform), reads the plan out of the same file, and can
  be pointed at the Keychain with the new `chutdown.usageKeychain`.

- **`CLAUDE_CONFIG_DIR` was ignored.** The credentials path was `~/.claude` unconditionally,
  so anyone who had relocated their Claude Code config had a meter that could not find a
  thing. `~/.claude.json` deliberately does *not* move with it, and does not here either.

- **A missing sign-in was retried like a failing server.** It went through the same
  doubling backoff as an endpoint error — to a thirty-minute ceiling, over something that
  will be exactly as missing in thirty minutes. It is a *named state* now, re-evaluated
  when the credentials file changes, when it moves, when the environment token appears or
  when a Keychain read lands, and never on a timer; each name gets one sentence on the
  hover and one line in the output channel saying what to do about it. The backoff is for
  the endpoint alone.

- **The plan label was frozen for the life of the window on a Mac.** Its cache was keyed
  on the credentials file's timestamp, and on a Mac there is no such file to stat — so
  whatever the first glance found (usually nothing) stayed. The key is now the resolved
  path, its timestamp, the environment token and the last Keychain read together.

- **The macOS port kill took direct children only.** `pkill -P` does not walk a tree, so
  `npm run dev` → `concurrently` → the actual server left the server alive holding the
  port. It is now a recursive walk that stops the parent first, so a supervisor cannot
  fork a replacement mid-walk, then kills leaves-first so nothing is reparented to
  `launchd` and escapes. It also refuses to build a command for a pid that is not one:
  `killPid(0)` used to emit `kill -9 0`, which signals the caller's process group — and
  nothing here is spawned `detached`, so that group is VS Code's extension host.

- **The `claude` terminal profile could not find `claude` on a Mac.** It ran
  `$SHELL -l -c`, which is a login but *non-interactive* shell, and zsh reads `~/.zshrc`
  only when interactive — which is where both common installs put `claude` on `PATH` (the
  native installer appends to it; an nvm install depends on nvm's own block there). The
  profile opened, printed `command not found: claude`, and dropped you into a shell where
  typing `claude` worked fine. Homebrew was the exception, which is why it looked fine on
  some Macs. It is `-l -i -c` now.

- **A power action that did not run said so only in the output channel** — which is
  nowhere near where somebody who walked away is looking, and by then the `.terminals`
  batch has already been Ctrl+C'd, so the visible result was a torn-down workspace and a
  machine still on. It is a warning now, carrying whatever the platform can say about the
  reason, and the gear **re-arms itself exactly once**: a permission you go and grant still
  gets the machine off tonight, while one that is never coming does not warn you every
  three minutes until morning.

- **A `soundFile` belonging to the other operating system silently became the system
  sound.** A settings value travels — Settings Sync, a dotfiles repo — and
  `C:\Windows\Media\chimes.wav` is not an absolute path on posix, so it was folded whole,
  backslashes and all, into one nonexistent filename inside the extension folder. The
  chime became the fallback while the toggle's hover went on naming a Windows wav and the
  picker offered it as a row that could never play. A foreign absolute path is now
  recognised, the bundled chime is used, and the output channel names the value.

- **A `claude` that could not be spawned turned the AI namer off until you reloaded the
  window.** The latch is right — nothing should re-spawn a broken CLI once a second — but
  the only way back was buried in a line in the output channel. Toggling `aiNames` or
  `aiNamesModel` now lifts it, which is the gesture somebody makes when they have just
  fixed the thing that broke it.

- `tmux` and `screen` are recognised as shell names. `tmux` is in VS Code's own default
  `terminal.integrated.profiles.osx` set and has no Windows counterpart, so a restored
  claude tab wearing that title was never paired — and on macOS the pid-file sweep that
  rescues an unrecognised tab on Windows does not run, so there was no second chance.

- The `.terminals` sample file no longer writes `Ctrl+Shift+P` into a Mac user's repo,
  and its `code --open-url` line now says that `code` needs *Shell Command: Install 'code'
  command in PATH* first on macOS. (Every other `Ctrl+C` in the docs is SIGINT, which is
  Ctrl+C on macOS too, and is left alone.)

- The transcript watcher's project filter can no longer swallow every wake in silence. It
  reads the first path segment of the changed file's name to decide whether the write
  could be one of ours; a name it cannot read that way now wakes a tick rather than being
  discarded, leaving the 5s poll as the only pump with not one line anywhere to say so.

- **A torn read of `~/.claude.json` latched a blank usage meter for a minute, and often
  for good.** The file is 70-odd KB and is rewritten constantly by every Claude Code
  process on the machine, so catching it mid-write is not rare. The mtime was recorded
  *before* the parse, so a failed read latched its own failure: the cached value became
  null, the recorded mtime became the mtime of the very write that tore it, and every look
  for the next sixty seconds — and then for ever, until some other process happened to
  rewrite the file — returned null. The mtime is now committed only once the read has
  succeeded, so the next poll re-stats, sees an mtime it never recorded, and reads again.
  On a default Mac install this is the meter's only source of numbers, so the cost of that
  bug was the whole meter. One deliberate consequence: once the file has been read, deleting
  it no longer blanks the reading for the life of the window.

- **The armed gear said ARMED on machines with no power action.** It accepted the click,
  wrote the gear into the cross-window ledger, waited for every session to finish, counted
  down for two minutes, stopped the `.terminals` batch with Ctrl+C — and then had nothing
  to run, having torn the workspace down in exchange for nothing. The gear is now skipped
  in the cycle wherever the configured action has no command behind it (**off → sound →
  notify → off**), and the click that would have armed it refuses instead, naming the
  action and the platform and offering **[Use the test action]** — which writes
  `chutdown.action: "test"` into whichever scope it is already set in and re-enters the
  gear for you — and **[Open settings]**. Three other doors to the same room were shut with
  it: changing `action` after arming repaints the item as *no `<action>` here* on the error
  background rather than leaving the ARMED claim on screen, another window's armed gear is
  no longer adopted where it cannot be honoured (its ledger stamp is still consumed, so
  this window neither re-decides it every poll nor publishes a contradiction back), and the
  fire path refuses at the front — before it claims the cross-window fire slot, before the
  progress notification, before anything is stopped — logging the reason once rather than
  once a poll. The question asked is a *capability* one and never an OS one, which is why
  none of it had to change when Linux acquired a power command. The gear itself is left
  where you put it, so setting `action` back to `test` makes it work again without a
  second click.

- **`forceCloseApps` was accepted and ignored on macOS**, and the output channel said so
  only afterwards, when it no longer mattered. It now does something on all three
  platforms, and on macOS what it does is the most destructive thing in the extension, so
  the disclosure moved to where it can still be acted on: the arm notification says it at
  the click and the armed hover repeats it. With the setting off — the default — both are
  byte-identical to what they said before. The post-mortem log line inverted to match: the
  usual case is now the positive one, which is the line that explains tomorrow morning why
  an editor came back without the file you were halfway through.

### Added
- **A rule about what a platform is allowed to offer**, written down in the manual next to
  the platform table because it is now a design principle rather than a preference:
  *Chutdown never offers a control it cannot honour.* A control that cannot act on the OS
  it is running on is either given a purpose that genuinely works there, or it is not
  contributed at all — and where it has to stay reachable, it says at the click what it
  cannot do and what will happen instead. Accepting a click, or a settings change, and
  doing nothing is the one outcome that is never allowed; a line in the output channel is a
  diagnosis, not a substitute for saying it where the user is standing. The rule is
  deliberately about the *click* and not the capability: implemented everywhere and refuses
  out loud both pass it, and *present, enabled, silent* is the only failure. Everything
  else in this release is that rule applied to the controls that were failing it.

- **Linux is implemented rather than declined.** The chime is
  `paplay`/`pw-play`/`aplay`/`ffplay`, the `notify` popup is
  `zenity`/`kdialog`/`xmessage`/`notify-send` — ordered by what each style *promises*
  rather than by which tool is commonest, so `dialog` takes the three that block until
  clicked before falling through to a banner that does not — the countdown window is
  `src/countdown.sh` driving `zenity --progress`, which ticks, and the power action is
  `systemctl poweroff`/`reboot` and `loginctl terminate-session`, with `forceCloseApps`
  adding `-i` to ignore inhibitor locks. Each chain is `command -v X && exec X` and ends in
  an `exit 127` naming what it looked for, so a box with none of the tools produces a
  sentence rather than a shell that exits 0 having done nothing. The port probe asks `ss`
  before `lsof`, because `ss` is iproute2 and is on every Linux box while `lsof` is a
  package that frequently is not, and a port probe that cannot see the pid holding the port
  is a restart button that silently does nothing. None of it has been run on a real Linux
  desktop; the command lines are pinned by the smoke suite, which is not the same thing,
  and the badge says so.

  The reasoning that used to decline all of this was right about one thing and wrong about
  the rest. A power command guessed wrong costs the user's unsaved work — `shutdown.js`
  stops the dev servers *before* it runs one — so `powerCommand()` is still `''` on any
  POSIX that is not macOS or Linux. A chime guessed wrong costs one logged `ENOENT` and the
  next branch of a chain. Those are not the same bet, and taking neither of them meant
  taking a worse one: a status bar that claimed to be armed.

- **Linux gets asked for permission the way macOS does, from the other end.** There is no
  up-front grant to raise — polkit decides at the moment of the call, which on an
  unattended machine is the worst possible moment — so arming asks logind `CanPowerOff`
  instead, a read-only method that answers `yes`, `challenge`, `no` or `na`. Only `yes`
  survives an empty room, and anything else refuses at the click with what it found: the
  polkit case names the two ways a session stops being local and active (SSH, or another
  user at the seat) and the rule that fixes it outright, and a machine with no systemd is
  told the thing that actually matters, which is that the sound, notify and countdown gears
  all still work there.

- **`forceCloseApps` on macOS is a real quit sweep.** One Apple event asks System Events
  for the unix ids of every application process that is not background-only and is not
  Finder, our own ancestors are removed from that list, and the rest get `SIGTERM`, two
  seconds, then `SIGKILL` — then the power event. Exactly one Apple event, and only to ask
  for pids; everything after it is POSIX signals, which need nobody's consent. Telling each
  app to quit individually would have cost one Automation grant per target app, a queue of
  prompts nobody answers at 3am, each blocking for AppleScript's two-minute timeout and
  each remembered for ever once it times out into a denial. `background only is false`
  rather than `visible is true`, because a minimised app blocks a shutdown exactly as hard
  as one in front. The walk up from `$$` removes our own editor whatever it ships as — Code,
  Insiders, VSCodium, Cursor — since killing it would take the extension host with it. And
  the sweep is joined to the power event with `;` and never `&&`, so if any of it fails
  `/bin/sh` still reaches the power event and the behaviour degrades to exactly the polite
  shutdown. A log out gets no sweep, matching Windows, which applies no `/f` to
  `shutdown /l`, and Linux, whose `terminate-session` has no inhibitor to ignore.

- **`chutdown.usageKeychain`** (default **off**, macOS only): let the usage meter read the
  Claude Code sign-in out of the login Keychain with
  `security find-generic-password -s "Claude Code-credentials"`, which is where macOS keeps
  it. Normally that read is silent — the item's access list trusts `/usr/bin/security`
  itself rather than whatever invoked it — but on some macOS builds a partition-list bug
  raises a password prompt that "Always Allow" cannot settle, and on macOS 26 the tool can
  hang instead of failing. So it is a deliberate click and never a fresh install: the read
  is fire-and-forget with a 5-second kill, at most one in flight and one every 15 minutes,
  and it never runs on the path that draws the status bar. Left off, the meter still shows
  the numbers Claude Code itself last cached, with their age.

- **Claude Code's own cached usage reading, out of `~/.claude.json`**, as the meter's last
  source of numbers — the body of the very same endpoint call, needing no token, no network
  and no permission on any platform. It is what puts real numbers on a default Mac install
  from the first second instead of a blank meter. It can be hours old while the file's
  timestamp is minutes old, so it is never written to the shared cache, never counted as a
  successful poll, and whenever it is what you are looking at the hover's header reads
  *from Claude Code's own cache, 3h old* in place of *fetched 14:32*. The same file
  supplies the plan when there is no credential to read it from.

- **macOS asks for its Automation permission at the moment you arm**, not two minutes into
  an unattended countdown. The power action is an Apple event, and macOS gates those behind
  a consent prompt charged to **Visual Studio Code** rather than to `osascript` — so left
  to the power action, that prompt appears with the dev servers already stopped and nobody
  in the room, blocks the event until answered, and then fails; answered *Don't Allow* it
  is remembered for ever. Arming now fires one harmless `count processes` instead, once per
  window and only for a real action, and a refusal is named on the spot with the System
  Settings path and the `tccutil reset AppleEvents com.microsoft.VSCode` remedy. The same
  sentence comes back if the power action itself is refused, which matters because that
  failure exits **1** — the same status a cancelled dialog leaves, so the text is the only
  thing that can tell them apart.

- The usage request carries a `claude-code` User-Agent, versioned off disk where the
  version is there to read. The reports are that a request without one lands in a far
  harsher rate-limit bucket — a 429 with `Retry-After: 0`, which never recovers, which is
  exactly the symptom the cache and the cross-window hold were built around. It is one
  header and no more: not licence to poll harder, and nothing about the hold changed.

### Changed
- **Tab identification is no longer Windows-only.** `identifyTabs` was the codebase's last
  documented OS exception: it listed processes with `Get-CimInstance` written inline, and
  switched itself off everywhere else, so a Mac or Linux tab that was already running
  `claude` before the window loaded stayed called `claude` for ever with no second chance.
  The listing and the pid-reuse check moved behind the platform contract — `ps -A -ww -o
  pid=,ppid=,lstart=` on every POSIX — and the gate `identify.js` reads is now
  *"is there any way to list processes here"* rather than *"is this Windows"*. Nothing else
  about the sweep is per-platform: the same 15s floor, the same 5-minute backoff, the same
  twelve-hop ancestry walk, kept identical on the cheaper platforms on purpose, since both
  gaps pace a question whose answer cannot change until the set of tabs does. The POSIX
  reuse check compares `ps` `lstart` strings under `LC_ALL=C`/`TZ=UTC`, which is both the
  comparator Claude Code itself uses and the environment it recorded the session under; a
  platform that cannot check answers *not recycled* rather than *no match*, so a wrong guess
  about a date format degrades to the sessions-file match alone instead of to a tab that can
  never be identified. Two macOS cases have no ancestry to walk and fail closed with one
  line rather than being papered over: under tmux or screen the tab's process is the
  multiplexer client while `claude` runs under the server, and a `claude` whose parent shell
  died is reparented to `launchd`.

- **The usage meter is no longer a control that cannot be honoured.** Three states changed:

  - With **no reading at all** — no token, no cached reading, nothing — the item is not
    contributed, instead of painting `$(pulse) usage?` and answering a click by cycling
    between nothing and nothing. The hide is a first-run state only and can transition
    exactly once, absent → painted, so it cannot flicker or shuffle the status bar while
    you are looking at it. The output channel now also names the cheapest fix: run `/usage`
    once in Claude Code and the meter will show that reading, with its age, needing no token
    and no permission. Computing the number from the transcripts on disk was measured and
    rejected — ~152ms per computation on a path that can run once a second on the extension
    host's one thread, a 1.9x overcount without per-message deduplication, 97.8% of the
    visible tokens being cache reads (so it tracks conversation length rather than limit
    spend), the whole sub-agent fleet invisible, and no denominator anywhere on disk, so it
    could never be the percentage this slot is made of.
  - On **macOS with `usageKeychain` off and nothing cached**, the item becomes a
    `$(key) usage` button that opens the setting, with a hover naming both fixes and putting
    the cheaper one first.
  - With **exactly one limit**, where cycling repaints identical content, the click opens
    the claude.ai usage page and the hover says so.

  All of them revert to the ordinary cycling click the moment a second limit lands, and the
  item's command is only rewritten when it actually changes — any property written to a
  status bar item closes an open hover.

- **`chutdown.usageKeychain` says so where there is no Keychain to read.** Switched on for
  the first time on Windows or Linux it now answers with one notification naming what is
  read instead — the environment token, `.credentials.json`, then Claude Code's own cached
  reading with its age — rather than accepting the change and doing nothing. It is the
  setting with *usage* in the name, so it is the one people reach for when the meter looks
  stuck.

- **Every settings description that named the wrong platforms was rewritten**, since for
  most people that text *is* the documentation. `identifyTabs` no longer says "Windows
  only" and names both listings; `forceCloseApps` replaced "WINDOWS ONLY" with what each of
  the three platforms actually does and what it costs; `action` says which platforms have a
  command and that the armed gear refuses elsewhere; `countdownPopup` and `notifyStyle` name
  the Linux tools; `soundFile` names the Linux players and the `.oga` default;
  `freePortsOnStart` stops omitting Linux, which it has always worked on; `usagePollMinutes`
  says it paces nothing without a live token; `usageMeter` says it needs no token on any
  platform; and `usageKeychain` leads with the upgrade framing rather than reading as a
  requirement.

- The chime picker accepts `.ogg` and `.oga`, the freedesktop sound set's format, and the
  Browse dialog's filter matches — otherwise its "on this machine" list on Linux would show
  files the file picker could not reach.

- The platform contract grew the five members that made all of the above testable from
  Windows: the tree kill as a *string* (so both platforms are asserted the same way rather
  than one of them being built inline and never checked), the Automation probe, the
  one-sentence hint for a failed power command, the Keychain argv, and the Keychain read
  itself. `shutdown.js` therefore still contains no `-1743` and no `security`.

  It then grew four more for the platform pass: `processTableArgv()` (the exact argv the
  process table is listed with, or `null` where it cannot be listed — pure and synchronous,
  so the command can be pinned from a machine that is not the one it runs on),
  `processTable()` (which never rejects; an empty Map means *could not read it*),
  `startMatches()` (whose `start` field is opaque to every caller — FILETIME ticks on
  Windows, a `ps` `lstart` string on POSIX — so only it may interpret it), and
  `countdownScript`. `identify.js` accordingly no longer requires `child_process` or
  contains the word PowerShell outside a comment about the bug that is now history.

### Changed
- The status bar launch buttons wear their model's own letter - **O** opus, **F**
  fable, **S** sonnet, **H** haiku - instead of four identical sparkles, so the footer
  button, the editor title button and the terminal tab that button opens all carry the
  same mark. A status bar item has no `iconPath` (its text takes icon *ids*, not file
  paths), so the letters ship a second time as glyphs in `media/chutdown.ttf`, built
  from the same geometry as `media/letter-*.svg` by `media/make-font.js` - dependency
  free, like the chime and the Marketplace icon. A hand-typed model outside the
  catalog has no letter and keeps its sparkle.
- The usage meter opens past a SPENT window instead of on it. A weekly Fable limit at
  0% left is the tightest limit for days, and it used to own the number for all of them -
  a red `0%` on every window reload, about a model you are done with until the window
  turns over, hiding the limits that say whether you can work right now. The meter now
  opens on the tightest window that still has room, names it so the skip cannot read as
  a reset, and the click still walks every limit including the spent one. An account
  with every window spent still opens on `0%` in red - that one is news.
- The meter labels a limit with the time LEFT in its window rather than the window's
  length: `27% 9h12m` and `85% 4h22m` instead of `27% week` and `85% 5h`. Five hours is
  five hours at every hour of the day and "week" says even less; when the number goes
  back up is the part worth a glance. It reads `47m`, `1h42m`, `19h`, `4d` as the reset
  gets further out. The per-model rows keep their model name (`0% Fable`), which is the
  only word telling one weekly limit from the next four.
- Clicking the usage meter now steps its number on to the next limit instead of
  opening the claude.ai usage page. A weekly window that is spent - Fable at 0% left -
  used to pin the meter to `0%` for days and hide the limits that still had room in
  them; the click walks the limits tightest first and wraps back to "whatever is
  tightest", naming the one it is showing (`45% week`) while it is not the default.
  The warning background follows the limit on screen, every limit stays on the hover
  with the shown one marked, and the usage page is now a link in that hover.

### Added
- A startup spinner in the status bar. Chutdown now activates in VS Code's first wave
  (`"*"` rather than `onStartupFinished`), which on a cold start is a minute earlier,
  and shows a spinner where the lights go until the first render and the one-off pass
  over the restored tabs have both finished.
- That pass now also asks claude's pid files which session each still-unbound tab is
  running, so a tab whose claude was already going when the window loaded gets its
  light back at startup instead of on the next poll gap.

### Changed
- A claude tab launched for a known model now wears that model's letter (**O** /
  **F** / **S** / **H**, the same marks as the editor title buttons) instead of the
  Chutdown "C", so the tab says which model is running in it. Batch `.terminals`
  entries that pin a model with `--model` get the letter too. The "C" stays for tabs
  whose model Chutdown cannot know: the + dropdown profile and hand-typed custom
  models. The mark survives a reload and a full restart — VS Code persists it with the
  tab.

### Added
- Sessions now carry the model they are running, read off the newest assistant record
  in the transcript (so a mid-session `/model` switch is reflected). Resuming a session
  opens its tab wearing that model's letter.
- The restore pass waits for the terminal tabs to stop arriving (up to a minute)
  instead of running on a flat 4s timer — activating earlier means the tabs can come
  back long after the extension does.

### Changed
- **The gear travels in the window heartbeat** rather than in a file of its own, so it
  can only ever be adopted from a window that is alive *now*. A marker left behind by
  a machine that armed itself yesterday is stale by definition, and a window that
  reloads picks the current gear back up instead of coming back "off" while another
  window counts down.

### Fixed
- **A finished workflow left its tab 🟢 for a quarter of an hour.** A background agent
  given a schema (`agent(..., {schema})`, which is most of what an `ultracode` run
  spawns) answers by calling `StructuredOutput`, so the last record in its transcript is
  the tool_result acknowledging that call - a *user* record, with no assistant
  `end_turn` behind it. `agentWorking()` read any trailing user record as a mid-turn
  tool_result, so every one of those agents looked busy for ever, and the session stayed
  🟢 *processing (background work)* - holding the chime and the armed shutdown with it -
  until each file aged past the 15-minute agent-dead bound. The CLI stamps those records
  `toolEndsTurn: true`, which is now read as what it says.

- **A window could arm itself, with nobody arming it.** The gear travelled between
  windows through a marker file in the temp dir, and a countdown that *stood down* —
  a session started working again, so the gear stayed exactly as it was — rewrote that
  marker with a fresh timestamp. Any window that had legitimately been off since,
  including one that had just been reloaded, read it as a new decision and armed
  itself. A gear is now only republished when it actually **changes**, so re-stating
  one moves nothing.

- **"local.chutdown unresponsive" in Show Running Extensions.** Two pieces of work ran
  on the extension host thread five times a minute — and again on every `fs.watch`
  wake, roughly once a second while any Claude anywhere was writing:
  - every scan statted every transcript in *every* project under `~/.claude/projects`
    (600 files across 22 projects on the machine this was found on), then threw away
    everything outside this workspace. Only the folders whose names can hold this
    workspace's sessions are walked now — Claude Code names them after the cwd — with a
    fallback to walking all of them if none match. A write under another project no
    longer wakes a tick at all.
  - every session in the 24-hour lookback had two sidecar trees walked recursively on
    every scan, to re-answer "are this morning's background agents still going?". A
    session that has written nothing for longer than an agent can be silent
    (`AGENT_DEAD_MS`) cannot have a live one, so those walks stop until it writes again.

  Measured on the same store: **38 ms per scan → 9 ms**, and ~430 filesystem calls per
  scan → ~190.

- Tab names after a full quit or a machine restart. VS Code brings the tabs back but
  not the processes, and the relaunched shell writes its own title over ours, so with
  Git Bash as the default profile every restored claude tab read `bash` — matching
  neither the creation name nor a saved title, so nothing was paired and the whole
  window came back nameless and unbound. The saved tab order now keeps a slot for every
  tab, claude or not, and the names go back on by position.

## [0.1.2] - 2026-08-19

### Fixed
- **The usage meter showed nothing at all on a machine that had never had a reading, which
  read as a broken feature rather than an empty one.** With no sign-in to poll with
  (`~/.claude/.credentials.json`, or `CLAUDE_CODE_OAUTH_TOKEN`) AND no reading Claude Code
  had cached (`~/.claude.json` → `cachedUsageUtilization`), `renderUsage` withdrew the
  status bar item outright and wrote the reason only to the Chutdown output channel. The
  reasoning was sound as far as it went — a slot whose click is registered, accepted and
  does nothing is an apology, not a control — but it missed what absence actually says to
  the person looking at it, which is "this is broken", not "nothing to report"; and the
  one place the real reason was written is a channel nobody opens unprompted. This was not
  hypothetical: it was found by installing the published build on a second Windows machine
  and reading the meter as missing.
  The slot is now painted in every first-run state, and the original objection is answered
  on its own terms rather than dropped — **the click always goes somewhere real.** On macOS
  with `usageKeychain` off it still goes to that setting, the shortest route to a live
  meter; everywhere else it opens the claude.ai usage page. The hover leads with the fix
  that costs nothing — run `/usage` once in Claude Code and the reading it leaves behind is
  painted from then on, with no token, no network and no permission prompt. The `everRead`
  latch is unchanged in purpose: the item is now contributed from the first poll and never
  withdrawn, which moves the tray's neighbours once **less** than the old absent → present
  transition did, not more.
- **That hover's codicons rendered as literal `$(link-external)` text**, because it was
  built without `supportThemeIcons`. Fixed for this hover; the main reading hover still has
  it and is tracked separately.

### Changed
- **The meter now opens on the SESSION window, and always says which limit it is showing.**
  It used to open on whatever was tightest-with-room, and suppress the label in exactly
  that case — so the same bare `62%` meant the session one day and the weekly Fable window
  the next, with nothing in the status bar to tell them apart. A reading you have to hover
  to identify is not a reading you can glance at, which is the whole job of the slot. It is
  now `62% 3h20m` — the session, labelled with what is left of it (or `5h` where the server
  sent no reset time), whatever else is tighter. A spent session is no longer stepped past
  either: `0% 4h12m` is the most useful sentence the meter can say — out now, back then —
  where a spent *weekly* window pinned at 0% for days was only ever a fact about a model you
  were done with. Accounts that report no session window at all fall back to the previous
  behaviour, unchanged. Every other limit stays one click away, tightest-first, and the full
  list stays on the hover.
- **The hover no longer calls a limit spent when it merely has less room than the one on
  screen.** The note explaining the default read `it opens past X, which is spent`, which
  was safe only while the default WAS the tightest. With a session default it would have
  fired on almost every account, asserting spentness of whatever happened to be tightest.
  It is now gated on that window actually being spent, and where it has room the note names
  it honestly instead: `Weekly - all models is tighter, at 45% left`.

## [0.1.1] - 2026-08-19

### Fixed
- **The bundled manual shipped a version behind.** `docs/MANUAL.md` was revised after the
  0.1.0 `.vsix` had already been built, and `vsce package` reads the working copy at the
  moment it runs — so the package that went to the Marketplace carried the 1579-line
  manual while the repository had the 1629-line one, 136 lines apart. The manual is the
  only file this affects: every other file in the 0.1.1 package is byte-identical to
  0.1.0, verified by hash. There is no code change here.
- **A note on the version number itself.** 0.1.0 cannot be re-uploaded — the Marketplace
  refuses a duplicate version — so a rebuilt package has to be a new one. The bump is
  also what lets an editor tell the two apart: a working copy installed as 0.1.0 and a
  published 0.1.0 are indistinguishable to VS Code, which is why a stale local build sat
  there reporting itself as up to date.

## [0.1.0] - 2026-08-18

First release.

### Added
- Traffic lights in the status bar: one clickable entry per Claude session, with
  state, quiet time, the prompt that started it, and the latest output on hover.
- An `(n) idle` dropdown that folds quiet sessions out of the individual lights.
- AI tab naming: a cheap headless `claude -p` call gives each session a one-word
  tab name, restored after a reload or a full restart and re-identified for tabs
  that predate the window.
- Model launch buttons in the status bar and the editor title bar, configurable
  through `Chutdown: Choose Models`.
- Batch terminals from a `.terminals` file: JSON (with comments) or the original
  `name @ subfolder = command` line form, with per-entry port freeing and lights.
- `vscode://d8a.chutdown/start|stop|restart` URI handling, workspace-scoped.
- An armable power action — off / sound / notify / ARMED — that waits for every
  Claude session in every window to finish, with a cancellable countdown.
- A Claude usage meter showing session and weekly limits.
- Windows and macOS support behind a single platform contract.
- Each editor-title letter icon is welded to its model, so a shortened button list
  cannot slide the next model in under the wrong letter.
- **The launch buttons follow your plan.** The default four are trimmed to the models
  the account can actually launch: Fable is a Max model unless usage credits are on, so
  a Pro account with no credits gets opus / sonnet / haiku and no dead **F** button. The
  reading is the usage meter's own — the plan in Claude Code's credentials file, plus
  the limit windows and credit state the usage endpoint reports — and it only ever holds
  back a model a *plan* gates: a reported limit window for a model proves entitlement,
  an unused model's `null` window proves nothing, and an unknown plan name (or no
  credentials file) offers everything. A list you picked yourself is untouched, with the
  hover saying once when a model is not included on your plan; the picker marks such a
  model `⚠` and still lets you tick it.
- **Renaming the tab by hand is adopted, not stamped over.** Rename a claude tab the
  way VS Code always allowed (double-click, right-click → Rename, F2) and the word
  becomes the session's name — deduplicated against the other sessions, cached across
  reloads, protected from the AI namer like any human-chosen name — with the traffic
  light stamped back in front of it. Titles a shell or the claude CLI writes on its
  own (cwd paths, spinner lines) are never mistaken for a rename.
- **`/rename` inside Claude Code is adopted too** (and `claude --name`). The CLI
  writes its session name into the same pid file the lights already read, marking
  the names it derived itself; a name without that mark is the user's, and it takes
  over the light and tab through the same deduplicate-cache-adopt path. Each
  `/rename` is adopted once, so a later rename from the tab or the hover is not
  fought over.
- **What a session was asked FIRST and LAST.** A light's hover carries both in its
  footer, above the *Click to show…* line: **First**, the prompt the session was started
  on (and where its one-word name came from), and **Latest**, the most recent thing you
  sent it. After a few hours those are rarely the same job, and the first prompt alone
  would say what a tab *was* for rather than what it is doing. They collapse back to one
  unlabelled line while a session is still on its opening prompt. `Copy text` copies
  both. The latest prompt costs no extra file reads — the same tail pass that decides the
  light's colour now keeps walking backwards for it, past the tool records of the turn in
  flight, and keeps the answer it already had when the prompt is older than what it reads.
- **Session history** (`Chutdown: Session History`, and the `History` link on the idle
  entry's hover): the whole list of remembered sessions — live ones as well as idle —
  newest first, grouped by age, each showing the clock time it last ran alongside how
  long ago that was. Pick one to open or resume it.

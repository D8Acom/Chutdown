# Open findings

All thirteen findings and all four nice-to-haves are **fixed** (2026-08-19), each with
regression assertions in `test/smoke.js` under `== BUG: … ==` headings. Nothing from the
original audit is outstanding. Kept as a record of what was wrong and why the code now
looks the way it does.

## Fixed

### High

**An undated CLI status file was treated as eternally fresh** — `src/scan.js`
`if (at && now - at > CLI_STATUS_MAX_AGE)` short-circuits on `at === 0`, so a file with no
timestamp skipped the freshness filter and refined live sessions for the rest of the
window. A stale `status: "idle"` reaching `applyCliStatus` turns a live `working` session
into `awaiting`, which `isFinished` counts as finished after the 3 s settle — the armed
gear could power off over live work. Now `if (!at || …)`: what cannot be dated cannot be
aged out, so it is dropped.

### Medium

**The armed gear killed every dev server, then discovered there was no power command** —
`src/shutdown.js` `stopAll(true)` ran before `execute()` asked the platform anything, and
`platform/index.js` routes every non-Windows platform to `darwin.js`, whose `powerCommand`
returns `''` off macOS. New `powerAvailable(action)` is asked at arm time (so the gear
cannot promise what it cannot do) and again at the top of the countdown handler, before
anything irreversible — the countdown now aborts having stopped nothing.

**Linux got the macOS module, and the docs promised otherwise** — `src/platform/darwin.js`
`soundCommand` and `notifyCommand` returned `afplay`/`osascript` commands unconditionally,
so the chime and popup gears announced themselves and then did nothing, five times a
minute, in silence. Both return `''` off macOS now — the contract every caller already
understood, which makes `notifyNow`'s `if (!cmd)` branch live and `playFile`'s new one say
so by name. README and MANUAL narrowed to match. Real `paplay`/`notify-send`/`zenity`
support is deliberately **not** added: it cannot be run or verified from here.

**The "n idle" count and its own click handler used different predicates** —
`src/lights.js` `renderSessions` pushed to `stale` from two conditions while `isIdle` — what
the click filtered by — tested only one of them, so "3 idle" could open a list of two.
`isIdle` is now the single predicate, applied by `renderSessions`, `showStale` and the
dropdown alike, and the empty case says something instead of returning silently.

**`startAll` had no re-entrancy guard, so two clicks made orphaned terminals** —
`src/batch.js` the `todo` loop only reads `termRecs`; the first write is after a port sweep
that can burn ten tries of 300 ms plus two `netstat` runs, so a second click built the
identical list. `launchEntryRec` disposes the previous record's *item* but not its
*terminal*, leaving the first unreachable from `termRecs` — unstoppable by `stopAll` and by
the armed pre-power sweep. Module-level `launching` flag in a `try/finally` (shared by
`startAll` and `restartAll`, which calls `startAllBody` past the guard), plus a
`launchingNames` set for the by-name path.

**A UTF-8 BOM made the whole `.terminals` file unparseable** — `src/terminals.js`
`looksLikeJson` passed (`trim()` eats U+FEFF) but `relaxJson` kept the byte, so `JSON.parse`
died on character one with a message carrying no `position`, which `jsonMessage` cannot turn
into a line and column. Unreadable error, every entry lost. Stripped once in
`parseTerminalsFile`.

**The usage meter could never work on macOS** — `src/usage.js` read only
`~/.claude/.credentials.json`, which Claude Code does not write on macOS (login Keychain
instead), so every poll found no token and doubled its backoff to the 30-minute cap
forever. Now resolved through `platform.keychainReadArgv()` behind the `chutdown.usageKeychain`
setting, with a **named** state per reason (`nofile`, `keychain:off`, `keychain:notfound`,
`keychain:nogui`, …) rather than a retry loop over something that will be exactly as
missing in thirty minutes.

### Low

**A terminal closed mid-sweep could be adopted and squat its session id forever** —
`src/claude.js` `claimTab` did no liveness check, and `identify.js` reaches it only after
awaiting `terminal.processId` and a `powershell.exe` process-table spawn. An adopted
corpse's only removal path was `claudeTabClosed`, an event that had already fired — so its
session id sat in the sweep's `taken` set for the life of the window and no real tab could
ever bind to it again. One `vscode.window.terminals.includes(terminal)` check at the top.

**`lookbackHours` was read unvalidated, and NaN disabled the scan window** — `src/scan.js`
new `lookbackMs()` clamps like `noReplyMs()` does. Unguarded, `st.mtimeMs < NaN` is false
for every file, so every transcript on the machine was statted and tail-parsed on every 5 s
poll, on the extension host thread.

**`runNamer` kept spawning after the `namerDead` latch was set** — `src/naming.js` the latch
was read only by `queueName`, so every give-up reason found mid-drain stopped *new* work
while the existing backlog went on spawning the process just proved not to run, twice over
via the retry. The drain guard reads it now and clears the queue.

**The 5-minute identify backoff was keyed on a title the CLI rewrites** — `src/identify.js`
the key came from `terminal.name`, the one property of an unidentified claude tab that
cannot hold still (a claude started before the window loaded writes its own status into its
title). The key differed on every poll, so the slow path was dead and a
`Get-CimInstance Win32_Process` listing ran every 15 s. Keyed on a `WeakMap` per-terminal id.

**Peer heartbeats were written non-atomically, and a torn read read as "not busy"** —
`src/shutdown.js` `writeFileSync` truncates before it writes and `readPeers` drops what will
not parse, so a dropped peer was *absent* rather than *unknown* — a fail-open on the one
check that stops one window powering off over another's work. Written to `.tmp` and
renamed; an unreadable file younger than `PEER_FRESH_MS` now counts as busy.

**`startAll` disposed a terminal before validating its cwd** — `src/batch.js` a missing
folder left the record in `termRecs` with a destroyed terminal and an undisposed
`StatusBarItem` that nothing would ever reach. The cwd is checked first; the `continue`
happens while the old terminal is still intact.

### Nice to have

- **The usage hover now escapes what it did not write** — `planLabel()`, `l.name` (title-cased
  from an arbitrary JSON key by design) and `usageError` go through `shared.mdText`.
- **The usage cache is keyed to the user** — `context.globalStorageUri` when there is one,
  `os.tmpdir()` only outside an activated extension.
- **The URI scheme is derived at runtime** — `sampleJson` builds its restart URL from
  `context.extension.id`, so a renamed publisher cannot leave the sample pointing nowhere.
- **`namerTries` is pruned** when the queue empties, for sessions no longer known.

## Deliberate — do not "fix" these

- **The `'unknown'` = "nothing to wait for" semantics.** An empty never-prompted tab must
  not hold the gears shut. Only the *unreadable-file* path into that state was wrong.
- **`darwin.isClaudeProfileTerminal` matching on `shellArgs` alone.** A POSIX login shell
  varies, so there is no `shellPath` to key on the way win32 does.
- **No TypeScript, no bundler, no dependencies.** Plain CommonJS with a zero-dependency
  test runner is a feature here, not debt.

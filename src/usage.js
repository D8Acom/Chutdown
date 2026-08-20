// Usage meter - the same rate-limit numbers /usage shows, polled from the OAuth
// usage endpoint with the token Claude Code already keeps: in a file under
// $CLAUDE_CONFIG_DIR on Windows, in the login Keychain on macOS, where there is no
// such file at all. The status bar shows the tightest "% left"; hover breaks down
// session / weekly / per-model limits with reset times. Click steps the number on to
// the next limit up (the claude.ai usage page is a link in the hover).

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const shared = require('./shared');
// For the OS credential store - the one thing about the sign-in that differs by
// platform. No cycle: platform requires only ../shared.
const platform = require('./platform');

let usageData = null;
let usageFetchedAt = 0;
let usageBusy = false;
let usageError = '';

// ------------------------------------------------------- one fetch, however many windows
//
// This endpoint rate-limits HARD: two requests seconds apart come back 429, and its
// Retry-After says 0, so there is nothing in the response to pace off. Nothing about the
// answer is per-window either - it is one number for the account - so every window asking
// for itself was pure waste, and the way it broke was invisible: each window kept its own
// "last tried" in memory, so N windows made N requests, and every window RELOAD started
// the clock again and fetched immediately. A few windows and a couple of reloads is all
// it takes to trip the limit, and the meter then reads "usage unavailable: HTTP 429".
//
// So the reading is cached in one file in the temp dir, keyed to nothing (there is one
// account): a window whose cached reading is younger than usagePollMinutes uses it and
// makes no request at all. `hold` is the other half - it is written BEFORE the request
// goes out, so a second window arriving mid-flight waits rather than racing, and it is
// what a failure extends into a backoff. Reloading a window is then free.
//
// The file lives in the extension's own globalStorage when there is one - a per-user,
// per-install directory the OS already protects - and falls back to the temp dir only
// when this is loaded outside an activated extension (the smoke suite does exactly
// that). The reading is one account's rate-limit percentages, and it was adopted from
// a fixed os.tmpdir() path with no ownership check: both supported platforms give each
// user a private temp dir, so this was never exploitable, but a shared-tmpdir setup is
// not a thing to rely on when the correct directory is already handed to us.
function cachePath() {
    const ctx = shared.state.extContext;
    const dir = ctx && ctx.globalStorageUri && ctx.globalStorageUri.fsPath;
    if (!dir) return path.join(os.tmpdir(), 'chutdown-usage.json');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    return path.join(dir, 'usage.json');
}
const IN_FLIGHT = 30_000;        // a request is given this long before another window retries
const MAX_BACKOFF = 30 * 60_000; // ...and a failing endpoint is never hammered faster than this
// Windows that come due in the same 5s tick would still race for the claim; a few seconds
// of per-window jitter separates them without anyone coordinating.
const JITTER = Math.floor(Math.random() * 20_000);

function pollMs() {
    return Math.max(1, Number(shared.cfg().get('usagePollMinutes')) || 5) * 60_000;
}

// ------------------------------------------------------------------- which plan
//
// The same file the token comes from says what the account is: `subscriptionType`
// ("max", "pro", …) and `rateLimitTier` ("default_claude_max_20x"), both written by
// Claude Code itself. That is worth showing, because the ROWS below differ by plan and
// the difference otherwise looks like a bug: a Pro account has no weekly Fable limit, so
// no Fable row appears, and without the plan on the hover the only reading available is
// "the meter is missing something".
//
// Which rows a plan gets is NOT hard-coded here, and deliberately: the server already
// answers `null` for a limit window an account does not have (as against 0, which would
// mean "have it, used none of it"), and those are the rows parseLimits drops. Plans and
// their model line-ups change; what the account is actually entitled to is the API's
// business, not a table in this file that goes quietly out of date.
function planFrom(creds) {
    const o = (creds && (creds.claudeAiOauth || creds)) || {};
    const sub = String(o.subscriptionType || '').toLowerCase();
    if (!sub) return '';
    // "default_claude_max_20x" -> the 20x is the part worth showing.
    const mult = /max_(\d+)x/.exec(String(o.rateLimitTier || ''));
    if (sub === 'max') return mult ? 'Max ' + mult[1] + 'x' : 'Max';
    return sub.charAt(0).toUpperCase() + sub.slice(1);
}

let plan = '';        // read once it can be read, refreshed whenever a fetch reads credentials

/// Latched on an ANSWER and not on a look. `plan === null` was the test, which latched ''
/// as firmly as "Max 20x" - and '' is not an answer, it is "there was nothing to read
/// yet". On the credential-less mac path that is the ordinary first look: a window opened
/// before Claude Code has ever written ~/.claude.json computes '', keeps it, and then goes
/// on showing a plan-less hover after /login while the launch buttons - which ask
/// credsCached() fresh on every rebuild - have already picked the plan up, so the two
/// disagree about one account until the window is reloaded. Re-asking while the answer is
/// empty costs a statSync-backed fingerprint and, past it, a cached read of ~/.claude.json
/// behind its own 60s floor.
function planLabel() {
    if (!plan) plan = planFrom(credsCached());
    return plan;
}

// -------------------------------------------- which models the account can launch
//
// The launch buttons offer four models, and not every account may use all four: Fable
// is a Max model unless the account is paying the overflow out of usage credits. A
// button whose only possible answer is "your plan does not include this model" is a
// worse first run than three buttons that all work, so claude.js asks here which
// models to offer before it builds them.
//
// Same rule as the ROWS above - what an account is entitled to is the API's business,
// not a table in this file - with the one asymmetry that makes it readable: the
// endpoint's positives are certain and its negatives are not. A limit window for a
// model (`seven_day_fable`, or a limits[] entry scoped to "Fable") is proof the account
// may use it. A null window is NOT proof of the opposite - per-model windows read null
// until the model is used - so a null is never read as "no". That leaves exactly one
// hard-coded thing, MODEL_PLAN: the models needing more than the entry-level plan. A
// model that is not in it is offered to everyone, which is the right direction for this
// list to go out of date in.
const MODEL_PLAN = { fable: 'max' };

/// Subscription types known to be BELOW Max. Anything else - team, enterprise, a plan
/// name this build has never heard of, or no credentials file at all - is left alone:
/// "we do not know" has to mean "offer it", or a plan named after this release quietly
/// loses a model it is entitled to.
const BELOW_MAX = ['free', 'pro'];

function subFrom(creds) {
    return String(((creds && (creds.claudeAiOauth || creds)) || {}).subscriptionType || '').toLowerCase();
}

/// The models the endpoint reports a limit window for, lowercased. Both response shapes
/// carry them: `seven_day_fable` as a key, or a limits[] entry scoped to a display name.
function meteredModels(data) {
    const out = new Set();
    if (!data || typeof data !== 'object') return out;
    for (const key of Object.keys(data)) {
        const m = /^seven_day_(.+)$/.exec(key);
        if (m && data[key] && typeof data[key] === 'object') out.add(m[1].toLowerCase());
    }
    if (Array.isArray(data.limits))
        for (const l of data.limits) {
            const name = l && l.scope && l.scope.model && l.scope.model.display_name;
            if (name) out.add(String(name).toLowerCase());
        }
    return out;
}

/// Usage credits - pay-as-you-go past the plan's limits, and the other way an account
/// reaches a model its plan does not include. `extra_usage` on the newer body, `spend`
/// on the older; either being switched on counts, unless the spend limit is already
/// reached, because credits that cannot be spent buy nothing.
function creditsOn(data) {
    const extra = (data && data.extra_usage) || null;
    const spend = (data && data.spend) || null;
    if (extra && extra.spend_limit_reached) return false;
    return !!((extra && extra.is_enabled) || (spend && spend.enabled));
}

/// Can this account launch `label` ("opus", "fable", ...)? Pure, so the smoke suite can
/// hand it a real response body. Returns { available, why } - `why` is the one line the
/// picker and the button hover show, empty when there is nothing to explain.
function modelAllowed(label, data, creds) {
    const key = String(label || '').toLowerCase();
    const needs = MODEL_PLAN[key];
    if (!needs) return { available: true, why: '' };            // offered to everyone
    if (meteredModels(data).has(key)) return { available: true, why: '' };   // the server meters it: yours
    const sub = subFrom(creds);
    if (!sub || !BELOW_MAX.includes(sub)) return { available: true, why: '' };  // Max, or unknown
    const plan = planFrom(creds) || 'your plan';
    const need = needs.charAt(0).toUpperCase() + needs.slice(1);
    if (creditsOn(data))
        return { available: true, why: 'Not included on ' + plan + ' - your usage credits pay for it.' };
    return { available: false,
        why: 'Not included on ' + plan + ' - needs ' + need + ', or usage credits switched on.' };
}

// The live side of the above. The credentials are re-read only when something that can
// CHANGE them has changed - the buttons rebuild on every configuration change, and
// parsing the sign-in again for each of them buys nothing - so signing in to a different
// account or upgrading a plan shows up at the next rebuild rather than a minute later.
let credsSig = '', credsVal = null;

/// FOUR things can change the answer and not one of them is a timer: the file being
/// rewritten, the file MOVING (CLAUDE_CONFIG_DIR), the environment token appearing, and a
/// Keychain read landing. Keyed on the file's mtime alone - which is what this was - there
/// is nothing to stat on a Mac at all, so the plan label was fixed at whatever the first
/// look found, for ever.
function credsFingerprint() {
    let mtime = 0;
    try { mtime = fs.statSync(credsFilePath()).mtimeMs; } catch { mtime = 0; }
    return credsFilePath() + '|' + mtime + '|' + (process.env[CRED_ENV] ? '1' : '0') + '|' + keychain.at;
}

/// The sign-in blob, or - where there is none to read, which on a default Mac is the
/// normal case - the plan identity out of Claude Code's own config file. Both answer the
/// only two questions asked of them: subscriptionType and rateLimitTier.
///
/// Only the blob is held against the fingerprint. The fallback is NOT, deliberately: none
/// of the four things the fingerprint watches moves when ~/.claude.json is rewritten, so a
/// Mac that had not signed in yet at the first look would have kept "no plan" for the life
/// of the window - and with it a Fable button gated on a plan nobody could read. It costs
/// nothing to leave out, because homeAccount reads through readHomeJson's own mtime cache.
function credsCached() {
    const sig = credsFingerprint();
    if (sig !== credsSig) { credsSig = sig; credsVal = credentialFor().creds; }
    return credsVal || homeAccount();
}

/// The best reading available to a caller that is not fetching: ours, another window's,
/// and last Claude Code's own cached one - which has no clock on it here, so nothing that
/// treats this as fresh may use it (renderUsage, which does say how old it is, goes
/// through cachedReading itself).
function usageSnapshot() {
    if (usageData) return usageData;
    const c = readCache().data;
    if (c) return c;
    const f = cachedReading();
    return f ? f.data : null;
}

/// What claude.js calls, once per model, as it builds the buttons.
function modelAvailability(label) {
    const data = usageSnapshot();
    const creds = credsCached();
    availabilitySig = sigOf(data, creds);      // what the buttons on screen were built from
    return modelAllowed(label, data, creds);
}

// A fetch can CHANGE the answer - credits switched on, a plan upgraded, a first Fable
// run creating its window - long after the buttons were built. Rather than reaching
// into claude.js from here (it already requires this module, and the reverse would be a
// cycle), extension.js leaves a callback, and it fires only when the answer moved.
let onAvailabilityChange = null;
let availabilitySig = '';

function sigOf(data, creds) {
    return JSON.stringify([[...meteredModels(data)].sort(), creditsOn(data), subFrom(creds)]);
}

function setAvailabilityListener(fn) { onAvailabilityChange = fn; }

function noteAvailability(data, creds) {
    const sig = sigOf(data, creds);
    const moved = availabilitySig && sig !== availabilitySig;
    availabilitySig = sig;
    if (moved && onAvailabilityChange) {
        shared.nlog('usage: what this account can launch changed - rebuilding the launch buttons');
        onAvailabilityChange();
    }
}

// --------------------------------------------------------------- where the sign-in lives
//
// Three places, and which of them has anything is not a detail this file may guess at.
// This used to read ~/.claude/.credentials.json and nothing else, which is correct on
// Windows and simply absent on macOS: Claude Code there keeps the OAuth credentials in
// the login Keychain and never writes that plaintext file. So on a first-class, declared
// platform, with `usageMeter` defaulting to true, the meter could not work at all - every
// poll found no token, took the generic "no sign-in token found" path, and doubled its
// backoff to the 30-minute cap for ever. planLabel() came back empty with it, so the
// hover lost its plan line too, and nothing anywhere named the actual reason.
const CRED_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

/// CLAUDE_CONFIG_DIR relocates the .claude DIRECTORY, and the credentials file moves with
/// it - which is why the meter found nothing for anyone who had set it. ~/.claude.json
/// does NOT move: Claude Code keeps its config file at the home directory whatever
/// CLAUDE_CONFIG_DIR says.
function claudeDir()     { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function credsFilePath() { return path.join(claudeDir(), '.credentials.json'); }
function homeJsonPath()  { return path.join(os.homedir(), '.claude.json'); }

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return null; }             // absent, unreadable, or caught mid-write
}

// Claude Code's own config file: 70 KB, rewritten constantly by every running Claude Code
// process, and every key this module reads out of it is UNDOCUMENTED internal state. So:
// mtime-keyed like the credentials file, FLOORED so a busy machine cannot make this a
// re-parse per poll, JSON.parse in a try/catch so a torn read is silence rather than a
// throw, shape-checked before anything is used, and never, ever written to.
//
// The mtime is committed only once the read has SUCCEEDED, and that ordering is the whole
// of the fix below. Written the other way round - stamp the mtime, then parse - a read
// that caught the file mid-write latched its own failure: homeVal became null, homeMtime
// became the mtime of the very write that tore it, and for the next sixty seconds (and
// then for ever, until some other process rewrote the file again) every look returned
// null. On a machine with two or three Claude Code processes rewriting 70 KB the odds of
// landing in a write are not small, and the cost of losing that read is now the whole
// meter: it is the only reading a default macOS install has, and with the empty-state
// hide below in place a torn read would make the status bar item VANISH for a minute and
// shift everything beside it along. Keeping the last good value instead means a torn read
// costs nothing at all - the next poll re-stats, sees the same unchanged mtime it never
// recorded, and reads again.
let homeAt = 0, homeMtime = -1, homeVal = null;
const HOME_FLOOR = 60_000;

function readHomeJson() {
    const now = Date.now();
    if (now - homeAt < HOME_FLOOR) return homeVal;
    homeAt = now;
    let mtime = 0;
    try { mtime = fs.statSync(homeJsonPath()).mtimeMs; } catch { mtime = 0; }
    if (mtime === homeMtime) return homeVal;
    const v = readJson(homeJsonPath());
    if (v) { homeMtime = mtime; homeVal = v; }
    return homeVal;
}

/// Claude Code caches the exact body of /api/oauth/usage on disk, on every platform, and
/// it is byte-for-byte what parseLimits already reads - both shapes at once. No token, no
/// network, no permission: it is what lets a default macOS install show real numbers from
/// the first second rather than a blank meter and a shrug.
///
/// STALENESS is the whole cost of it, and it can be severe - Claude Code refreshes this
/// only when it fetches usage itself (you opened /usage, or its account dialog), so a
/// snapshot can be HOURS old while the file's own mtime is minutes old. First paint and
/// last resort, never a substitute for polling, and the hover says how old it is.
function cachedReading() {
    const j = readHomeJson();
    const c = j && j.cachedUsageUtilization;
    if (!c || typeof c !== 'object') return null;
    const u = c.utilization;
    const at = Number(c.fetchedAtMs) || 0;
    if (!u || typeof u !== 'object' || !at) return null;
    if (!parseLimits(u).length) return null;      // an internal key that moved: silence, not an error
    return { data: u, at };
}

/// Claude Code's config carries the account's plan identity even when there is no
/// credentials file to read it from, which on macOS is the normal case - and it is what
/// makes the hover's plan line and the Fable launch-button gating right on a Mac. Mapped
/// onto the two fields planFrom/subFrom already read and nothing else: organizationType is
/// "claude_max" where the credentials file says "max", and the tier is the user's when
/// there is one and the organization's otherwise. The block this comes out of also carries
/// the account email; nothing here reads it and nothing here logs any of this.
function homeAccount() {
    const a = (readHomeJson() || {}).oauthAccount;
    if (!a || typeof a !== 'object') return null;
    const sub = String(a.organizationType || '').replace(/^claude_/, '');
    if (!sub) return null;
    return { subscriptionType: sub,
             rateLimitTier: String(a.userRateLimitTier || a.organizationRateLimitTier || '') };
}

// The Keychain is the one credential source that cannot be read synchronously, and the two
// sync callers below (credsCached, and the credential lookup fetchUsage does) must not
// learn to await. So it is not bridged, it is CACHED: this refresher is fired and
// forgotten, writes its answer here, and the sync path reads whatever it last left. The
// cost is that the very first tick on a Mac has no token yet - which costs nothing, because
// the numbers on that tick come from ~/.claude.json anyway.
const KEYCHAIN_TTL = 15 * 60_000;
let keychain = { at: 0, creds: null, reason: '', busy: false };

function keychainWanted() {
    return !!shared.cfg().get('usageKeychain') && !!platform.keychainReadArgv();
}

function refreshKeychain() {
    if (keychain.busy || !keychainWanted()) return;
    if (keychain.at && Date.now() - keychain.at < KEYCHAIN_TTL) return;
    keychain.busy = true;
    platform.readStoredCredentials().then((r) => {
        keychain = { at: Date.now(), creds: r.creds, reason: r.reason, busy: false };
        renderUsage();
    }, () => { keychain = { at: Date.now(), creds: null, reason: 'failed', busy: false }; });
}

/// Ordered, and the order is the argument: a token the user exported themselves beats a
/// file, a file beats the Keychain, and the Keychain is not consulted at all unless the
/// user has asked for it. CLAUDE_CODE_OAUTH_TOKEN is a BARE token string, not JSON, so it
/// has to bypass the claudeAiOauth unwrap - and it carries no subscriptionType, which is
/// what homeAccount() is for.
///
/// `reason` is a NAMED state, not a failure to retry: a missing credential changes when a
/// file, an environment variable or a setting changes, and never on its own. Routing it
/// through backOff() - doubling to a thirty-minute cap over a thing that will still be
/// exactly as missing in thirty minutes - is what made the macOS case feel like a broken
/// meter instead of a meter saying something true.
function credentialFor() {
    const env = String(process.env[CRED_ENV] || '').trim();
    if (env) return { token: env, creds: null, reason: '' };

    const file = readJson(credsFilePath());
    const fileTok = file && (file.claudeAiOauth || file).accessToken;
    if (fileTok) return { token: String(fileTok), creds: file, reason: '' };

    if (keychainWanted()) {
        refreshKeychain();
        const k = keychain.creds;
        const kTok = k && (k.claudeAiOauth || k).accessToken;
        if (kTok) return { token: String(kTok), creds: k, reason: '' };
        // Before the first read lands there is nothing to name yet - say nothing.
        return { token: '', creds: null, reason: keychain.at ? 'keychain:' + (keychain.reason || 'failed') : '' };
    }
    if (platform.keychainReadArgv()) return { token: '', creds: null, reason: 'keychain:off' };
    return { token: '', creds: null, reason: 'nofile' };
}

/// One sentence per named state, each of them pointing somewhere: "the meter is blank" is
/// only a bug report while the reason for it is unsaid. Shown on the hover under whatever
/// numbers there are - and there usually are some, because Claude Code's own cached
/// reading needs no credential at all. 'nofile' is the one that has to be built rather
/// than looked up: naming the path is the whole value of it, and CLAUDE_CONFIG_DIR moves
/// that path.
const CRED_TEXT = {
    'keychain:off': 'macOS keeps the Claude Code sign-in in the login Keychain, so there is no file to ' +
        'read. Switch on chutdown.usageKeychain and Chutdown will ask the Keychain for it.',
    'keychain:notfound': 'not signed in to Claude Code on this Mac - run /login in Claude Code.',
    'keychain:nogui': 'macOS will not release the Keychain item without a desktop session - over SSH ' +
        'or Remote-SSH there is nobody there to unlock it.',
    'keychain:denied': 'the Keychain read was refused.',
    'keychain:timeout': 'the Keychain read did not answer in 5 seconds - switch chutdown.usageKeychain ' +
        'back off to stop trying.',
    'keychain:failed': 'the Keychain read failed - see the Chutdown output channel.'
};

function credText() {
    if (credState === 'nofile')
        return 'no Claude Code sign-in at ' + credsFilePath() + ' - run /login in Claude Code.';
    return CRED_TEXT[credState] || '';
}

/// Named once, by name, and not once a poll for ever.
let credLogged = '';
let credState = '';

/// The second line is only written when there is nothing on screen to read the first one
/// beside. In that state - no token anywhere AND no cached reading anywhere - the meter is
/// not in the status bar at all, so the channel is the only place the reason can be said,
/// and a reason without the fix beside it is half a sentence. The fix that costs nothing
/// goes first every time: Claude Code writes its own reading into ~/.claude.json the
/// moment you ask it for one, and Chutdown paints that on any platform, labelled with its
/// age, with no token, no network and no permission prompt involved anywhere.
function setCredState(s) {
    credState = s || '';
    if (credState && credState !== credLogged) {
        credLogged = credState;
        shared.nlog('usage: ' + credText());
        if (!shownLimits().limits.length)
            shared.nlog('usage: no reading anywhere yet, so the meter stays out of the status bar - ' +
                'run /usage once in Claude Code and Chutdown will show that reading, with its age - ' +
                'no token and no permission needed.');
    }
    if (!credState) credLogged = '';
}

/// The request Claude Code makes carries a claude-code User-Agent, and the reports are that
/// one without it lands in a far harsher rate-limit bucket - 429 with Retry-After: 0, which
/// never recovers, which is exactly the symptom the cache/hold/backoff above was built
/// around. Community-sourced and NOT verified here (verifying it means spending a request
/// against the very endpoint that is rate limiting us), so it is one header and no more: it
/// is not licence to poll harder, and the cross-window hold stays exactly as it is. The
/// version is free off disk; without it the name goes without one rather than inventing it.
let ua = '';

function userAgent() {
    if (ua) return ua;
    const v = readJson(path.join(claudeDir(), '.last-update-result.json'));
    const ver = String((v && v.version_to) || '').trim();
    ua = /^[0-9][0-9A-Za-z.\-]*$/.test(ver) ? 'claude-code/' + ver : 'claude-code';
    return ua;
}

function readCache() {
    try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) || {}; }
    catch { return {}; }              // no cache yet, or another window mid-write
}

function writeCache(c) {
    try { fs.writeFileSync(cachePath(), JSON.stringify(c)); }
    catch (e) { shared.nlog('usage: cache: ' + e.message); }
}

function usageTick() {
    if (!shared.cfg().get('usageMeter')) { shared.unpaint(shared.items.usage); return; }
    const cache = readCache();
    // Someone else's fetch is as good as ours - the endpoint answers for the account.
    if ((cache.at || 0) > usageFetchedAt && cache.data) {
        usageData = cache.data;
        usageFetchedAt = cache.at;
        usageError = '';
    }
    // The credential is looked at BEFORE the hold and before the poll clock: with no
    // credential there is nothing to hold, nothing to claim, and no request to pace. A
    // missing sign-in is a state, and the numbers Claude Code itself cached are still
    // shown under it - what it is not is a failure to retry until the backoff caps out.
    const cred = credentialFor();
    if (!cred.token) { setCredState(cred.reason); renderUsage(); return; }
    setCredState('');
    renderUsage();
    if (usageBusy) return;
    const now = Date.now();
    if (now < (cache.hold || 0)) return;                          // in flight, or backing off
    if (now - (cache.at || 0) < pollMs() + JITTER) return;        // still fresh enough
    fetchUsage(cache, cred);
}

/// Every ENDPOINT failure lands here - a non-200, a network error, an unreadable body, a
/// 200 with no limits in it - and nothing else does. The reading we already had is KEPT (a
/// stale number with a "last refresh failed" note beats no number), and the next attempt
/// is pushed out, doubling each time, so an endpoint that is refusing us is asked less
/// often, not more. A missing CREDENTIAL is not one of these and never comes here: it is a
/// named state that changes when a file or a setting changes, so doubling a retry over it
/// to a thirty-minute cap only ever produced a meter that looked broken.
function backOff(cache, msg, retryAfter) {
    const fails = (cache.fails || 0) + 1;
    // Retry-After is honoured when it says something useful. This endpoint sends 0, which
    // means "later" and not "immediately", so 0 falls through to the doubling.
    const wait = retryAfter > 0 ? retryAfter * 1000
        : Math.min(MAX_BACKOFF, pollMs() * Math.pow(2, fails - 1));
    writeCache({ at: cache.at || 0, data: cache.data || null, fails, error: msg, hold: Date.now() + wait });
    usageError = msg;
    shared.nlog('usage: ' + msg + ' - next try in ' + Math.max(1, Math.round(wait / 60_000)) + ' min' +
        (fails > 1 ? ' (' + fails + ' failures in a row)' : ''));
    renderUsage();
}

/// Handed the credential usageTick already looked up rather than reading it again: there
/// is exactly one lookup per tick, and the token that paid for the request is the same one
/// the plan line on the hover is named from.
function fetchUsage(cache, cred) {
    usageBusy = true;
    // Claimed before the request leaves, not after it lands: the point is that the OTHER
    // windows can see it is already being done.
    writeCache(Object.assign({}, cache, { hold: Date.now() + IN_FLIGHT }));
    // Named from whatever the credential carried, and where that is a bare environment
    // token carrying nothing, from Claude Code's own config - so switching accounts or
    // upgrading a plan shows up on the hover at the next poll rather than at the next
    // window reload.
    plan = planFrom(cred.creds) || planFrom(homeAccount());

    const req = https.request({
        host: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + cred.token,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': userAgent()
        }
    }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
            usageBusy = false;
            if (res.statusCode !== 200) {
                backOff(cache, res.statusCode === 401
                    ? 'token expired - refreshes next time Claude Code talks to the API'
                    : res.statusCode === 429
                        ? 'HTTP 429 - the usage endpoint is rate limiting us'
                        : 'HTTP ' + res.statusCode,
                    Number(res.headers['retry-after']));
                return;
            }
            let parsed;
            try { parsed = JSON.parse(body); }
            catch { backOff(cache, 'unreadable response'); return; }
            // A 200 that yields nothing we can read is a FAILURE, not a success: the old
            // code cleared the error, found no limits, and returned early - leaving
            // whatever the item last said (often "HTTP 429") frozen on screen for ever.
            if (!parseLimits(parsed).length) {
                backOff(cache, 'the usage endpoint returned no limits we recognise');
                return;
            }
            usageData = parsed;
            usageFetchedAt = Date.now();
            usageError = '';
            writeCache({ at: usageFetchedAt, data: parsed, fails: 0, hold: 0 });
            renderUsage();
            // credits switched on? plan upgraded? rebuild the buttons
            noteAvailability(parsed, cred.creds || homeAccount());
        });
    });
    req.on('error', (e) => { usageBusy = false; backOff(cache, e.message); });
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    req.end();
}

// The endpoint has answered in two shapes. The one this meter was written against is an
// array of limits, each with its own `kind`/`percent`. What it returns NOW is one key per
// limit window - `five_hour`, `seven_day`, `seven_day_opus`… - each an object with a
// `utilization` percentage, and the per-model ones null until you have used that model.
// Both are read, because there is no telling which an account or a future release gets,
// and a meter that silently shows nothing is the worst of the three outcomes.
const LIMIT_NAMES = {
    five_hour: 'Session (5h)',
    seven_day: 'Weekly - all models',
    seven_day_opus: 'Weekly - Opus',
    seven_day_fable: 'Weekly - Fable',
    seven_day_sonnet: 'Weekly - Sonnet',
    seven_day_haiku: 'Weekly - Haiku',
    seven_day_cowork: 'Weekly - Cowork',
    seven_day_oauth_apps: 'Weekly - API apps'
};

/// Unknown keys are NAMED, not dropped: a limit window this build has never heard of is
/// still a limit, and "Weekly - opus 4 1" on the hover beats leaving it out.
function limitName(key) {
    if (LIMIT_NAMES[key]) return LIMIT_NAMES[key];
    const weekly = /^seven_day_(.+)$/.exec(key);
    const rest = (weekly ? weekly[1] : key).replace(/_/g, ' ');
    return (weekly ? 'Weekly - ' : '') + rest.charAt(0).toUpperCase() + rest.slice(1);
}

/// Pure, so the smoke suite can hand it a real response body. Everything it returns is
/// {name, percent used, resetsAt}.
function parseLimits(data) {
    const out = [];
    if (!data || typeof data !== 'object') return out;
    if (Array.isArray(data.limits)) {
        for (const l of data.limits) {
            if (typeof l.percent !== 'number') continue;
            const name = l.kind === 'session' ? 'Session (5h)'
                : l.kind === 'weekly_all' ? 'Weekly - all models'
                : l.scope && l.scope.model && l.scope.model.display_name
                    ? 'Weekly - ' + l.scope.model.display_name
                    : l.kind;
            out.push({ name, percent: l.percent, resetsAt: l.resets_at });
        }
        return out;
    }
    for (const key of Object.keys(data)) {
        const v = data[key];
        if (!v || typeof v !== 'object') continue;          // null = a model you have not used
        const percent = typeof v.utilization === 'number' ? v.utilization
            : typeof v.percent === 'number' ? v.percent : null;
        if (percent === null) continue;
        out.push({ name: limitName(key), percent, resetsAt: v.resets_at });
    }
    return out;
}

function usageLimits() {
    return parseLimits(usageData);
}

/// The rows actually ON SCREEN, and where they came from. What Claude Code itself last
/// cached stands in until a reading of our own lands, and only then: it needs no token and
/// no network, which is the whole point of it on a Mac with nothing to poll with, but it is
/// a snapshot of unknown age and never displaces a reading we fetched. Whenever it is what
/// is on screen the header says so, and says how old it is - there is no version of this
/// that is allowed to pass for fresh.
///
/// One function for both readers, because the click steps through the rows the hover is
/// showing: built separately, the meter would invite a click that walked an empty list.
///
/// `everRead` is a one-way latch on "this account has shown a number at least once", and
/// it is set HERE rather than in renderUsage so that every reader marks it - the click and
/// the log line ask the same question the paint does. It exists for the empty state
/// (renderUsage says why): before the first reading the meter is not in the status bar at
/// all, and after one it never leaves again. One-way, because an item that appears and
/// disappears as readings come and go would shift every neighbour along the tray each
/// time, which is a worse thing to do to the status bar than parking a stale number in it.
let everRead = false;

function shownLimits() {
    const mine = usageLimits();
    if (mine.length) { everRead = true; return { limits: mine, stale: null }; }
    const stale = cachedReading();
    const limits = stale ? parseLimits(stale.data) : [];
    if (limits.length) everRead = true;
    return { limits, stale };
}

// ------------------------------------------------------ which limit the number shows
//
// The status bar has room for ONE number, and the tightest limit is the right default:
// the window you will hit first is the one worth watching. It stops being the right
// number the moment a window is SPENT. A weekly Fable limit at 0% left pins the meter
// to "0%" for days, and none of that is news - it says nothing about whether you can
// work right now, and it hides the four limits that answer that question.
//
// So the click steps the number on to the next limit instead, walking them tightest
// first and wrapping back to "whatever is tightest" at the end. Clicking is the whole
// gesture - no setting, no memory between windows - because the reason to look past a
// limit lasts as long as that limit does, not as long as the install.
//
// Only the NUMBER moves. Every limit is still on the hover, in the same order, with the
// shown one marked - so stepping past a spent window never means losing sight of it.
let focus = '';   // '' = whatever is tightest; otherwise the name of the shown limit

/// Tightest first: the order the click walks. Ties keep the server's order (sort is
/// stable), so equal limits do not swap places between fetches.
function byTightest(limits) {
    return limits.slice().sort((a, b) => pctLeft(a.percent) - pctLeft(b.percent));
}

/// What the meter OPENS on (USER'S RULING, 2026-08-20): the limit with the LOWEST "% left"
/// that still has room in it - the window you will hit first - and the click steps on from
/// there. For a while it opened on the session window instead, on the argument that a
/// number whose meaning moved between windows had to be hovered to be read; that argument
/// went away once the number was always labelled ('45% 4d' cannot be mistaken for the
/// session), and what was left was a meter showing a comfortable session while a weekly
/// window ran dry behind it. The lowest number is the one worth the slot.
///
/// A SPENT window (0% left) is still stepped past by default: pinned at 0% for days it says
/// nothing about whether you can work right now, and it is one click away (the click walks
/// every limit, spent ones included). Only when every window is spent does the meter open
/// on 0% - then that is the whole news.
function defaultLimit(order) {
    return order.find((l) => pctLeft(l.percent) > 0) || order[0];
}

/// The row the status bar number comes from. A focus that no longer exists - the window
/// reset away, the plan changed, the endpoint stopped reporting it - falls back to the
/// default rather than leaving the meter with nothing to show.
function focused(limits) {
    const order = byTightest(limits);
    return (focus && order.find((l) => l.name === focus)) || defaultLimit(order);
}

/// The click, which walks EVERY limit including the spent one the default skips - the
/// point of stepping past a window is being able to step back to it. Wrapping lands on
/// '' rather than on the default BY NAME, so the default keeps tracking whatever is
/// tightest-with-room as the numbers move.
function cycleUsageFocus() {
    const order = byTightest(shownLimits().limits);
    if (!order.length) return;
    const shown = focused(order);
    const next = order[(order.indexOf(shown) + 1) % order.length];
    focus = next === defaultLimit(order) ? '' : next.name;
    renderUsage();
}

/// 'Weekly - Fable' -> 'Fable'. The status bar can spare a word for which limit is being
/// shown, not a sentence - and the full name is on the hover.
///
/// The two rows that have no name worth showing get the time LEFT in their window
/// instead. "5h" is the same five hours at every hour of the day and "week" says even
/// less - both are the window's length, and the length is the one thing about a window
/// that never changes. When it turns over is what a glance is after.
///
/// The per-model rows keep their model name: "Opus" is what tells one weekly limit from
/// the next four, and they can all reset within minutes of each other, so a countdown
/// there would trade the only distinguishing word for a number shared with its siblings.
function shortName(l) {
    const weekly = /^Weekly - (.+)$/.exec(l.name);
    if (weekly) return weekly[1] === 'all models' ? (timeLeft(l.resetsAt) || 'week') : weekly[1];
    const session = /^Session \((.+)\)$/.exec(l.name);
    if (!session) return l.name;
    return timeLeft(l.resetsAt) || session[1];   // no usable reset time -> the old label
}

/// '47m' / '1h42m' / '19h' / '4d' - the countdown resetIn deliberately keeps OFF the
/// hover, which is a different problem: a hover whose text rewrites itself is one VS Code
/// closes mid-read, and the reset clock is there to be read. Here it is one word in the
/// status bar that changes at most once a minute, and all that costs is a hover held open
/// across the tick.
///
/// The gears coarsen with the distance because the precision stops meaning anything: a
/// session window is minutes-and-hours all the way down, but a weekly one starts 168
/// hours out, where '167h58m' is six characters of noise around 'a week'. Ceil at every
/// gear, so it counts down to '1m' rather than sitting on '0m' for a minute.
function timeLeft(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso) - Date.now();
    if (isNaN(ms) || ms <= 0) return '';
    const mins = Math.ceil(ms / 60_000);
    if (mins < 60) return mins + 'm';
    if (mins < 12 * 60) return Math.floor(mins / 60) + 'h' + String(mins % 60).padStart(2, '0') + 'm';
    if (mins < 48 * 60) return Math.ceil(mins / 60) + 'h';
    return Math.ceil(mins / (24 * 60)) + 'd';
}

/// The same gears the other way round, for an age rather than a countdown: '12m', '3h',
/// '2d'. FLOORED where timeLeft ceils - a reading taken two hours and fifty minutes ago is
/// "2h old", because the honest direction to round an age is the one that cannot make a
/// stale number sound fresher than it is. This one only ever appears beside a number that
/// is NOT being refreshed, so it changes at most once a minute and cannot churn a hover.
function ageOf(ms) {
    const mins = Math.max(0, Math.floor((Number(ms) || 0) / 60_000));
    if (mins < 60) return mins + 'm';
    if (mins < 48 * 60) return Math.floor(mins / 60) + 'h';
    return Math.floor(mins / (24 * 60)) + 'd';
}

function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/// WHEN it resets, not how long until it does. "resets in 59m" counts itself down, so the
/// hover's text changes every minute all by itself - and a hover whose text changes is one
/// VS Code closes, however carefully the write is guarded (shared.paint). A clock time is
/// the same information and holds still between fetches. The weekday is added for anything
/// far enough out that "at 12:59" would be ambiguous - which is every weekly limit.
function resetIn(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (isNaN(t) || t <= Date.now()) return '';
    const soon = t - Date.now() < 12 * 3600_000;
    return ' - resets ' + (soon ? 'at ' : new Date(t).toLocaleDateString([], { weekday: 'short' }) + ' ') +
        clock(t);
}

/// The server reports a PERCENT, and nothing says it is an integer or that it stops
/// at 100 - the "% left" clamps below exist because it can go over. The bar has to
/// clamp too: 'x'.repeat(-1) throws RangeError, and this function is called from the
/// https response handler where a throw is an uncaught exception that leaves the meter
/// dead for the life of the window.
function bar(percent) {
    const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/// 100 - 37.4 is 62.599999999999994 in IEEE754, and that is what used to go in the
/// status bar. One place to round, used by the item and every hover row.
function pctLeft(percent) {
    return Math.round(Math.max(0, 100 - percent));
}

// ---------------------------------------------------- what the click does, per state
//
// One status bar slot, and the click that belongs in it is not the same click in every
// state. The status bar has no way to say "this one does nothing": a registered command
// that returns early is indistinguishable, from the outside, from a command that worked,
// so an item wired to cycleUsageFocus while there is one limit - or none at all - swallows
// the click and leaves the user tapping a number that was never going to move. Each state
// therefore carries the click that is true for it:
//
//   two or more limits   cycleUsageFocus   the number steps on to the next window
//   one limit, or none   openUsagePage     there is nothing to cycle to, and the page is
//                                          the answer to the question the click was asking
//   keychain:off         openSettings      the one thing that turns this into a reading
//                                          that refreshes itself
//
// Assigned behind a !== rather than written every render, because `command` is a property
// shared.paint does not diff, and EVERY write to a StatusBarItem property re-renders the
// item - which closes the hover the user is reading. That is also why the settings command
// is a module-level constant and not an object literal built at the call site: a fresh
// { command, arguments } each time is !== every time, and would twitch the hover shut on
// every five-second poll.
const KEYCHAIN_SETTING = {
    command: 'workbench.action.openSettings',
    title: 'Open the chutdown.usageKeychain setting',
    arguments: ['"chutdown.usageKeychain"']
};

function setCommand(item, cmd) {
    if (item.command !== cmd) item.command = cmd;
}

/// THE FIRST RUN: no number at all, on any platform, because nothing has ever produced
/// one on this machine. Every route into it ends up here.
///
/// This used to be two different answers. macOS with `usageKeychain` off got the hover
/// below - the one state thought worth explaining, because a click could fix it. Every
/// OTHER way of having no number - a fresh Windows or Linux box where Claude Code has not
/// yet written a reading and there is no sign-in to poll with - got `unpaint`, i.e. no
/// status bar item whatsoever, with the reason written only to the output channel. The
/// argument for that was sound as far as it went: a slot saying "usage?" whose click does
/// nothing is not a control, it is an apology. What it missed is that ABSENCE is not
/// read as "nothing to report" by the person looking at it - it is read as "this feature
/// is broken or missing", and the one place the real reason was written is a channel
/// nobody opens unprompted. That is not a hypothetical: this extension's own author
/// installed the published build on a second Windows machine and reported the meter as
/// missing.
///
/// So the slot is now painted in every first-run state, and the objection is answered on
/// its own terms rather than ignored - the click always goes somewhere real. On macOS
/// with the setting off that is still the setting itself, one click, the shortest route
/// to a live meter. Everywhere else it is the claude.ai usage page: not a fix for the
/// meter, but the actual numbers, which is what the click was reaching for.
///
/// The hover leads with the free fix in both cases. Running /usage in Claude Code needs
/// no token of ours, no network of ours and no permission prompt anywhere, and one run
/// leaves a reading in ~/.claude.json that this meter paints from then on.
///
/// This does not reintroduce the churn `everRead` exists to prevent. That latch stops the
/// item vanishing again once a number has landed; painting here means the slot is present
/// from the first poll instead of appearing later, so it moves the tray's neighbours
/// strictly LESS than the old absent -> present transition did.
function paintNothingYet(usageItem) {
    // The two-route state (macOS, Keychain readable but not switched on) is the only one
    // with a setting worth offering; everywhere else naming it would be noise about a
    // toggle that is ignored on this platform.
    const keychain = credState === 'keychain:off';
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['workbench.action.openSettings', 'chutdown.openUsagePage'] };
    // Without this the codicons in the links below render as the literal text
    // '$(link-external)', which is what they were doing here before.
    md.supportThemeIcons = true;
    md.appendMarkdown('**Claude usage** - nothing to show yet  \n\n');
    // The cheaper fix first, and it really is free: /usage costs one request Claude Code
    // was going to make anyway, and it leaves the reading behind in ~/.claude.json where
    // this meter can paint it from then on, on any platform, with nothing switched on.
    md.appendMarkdown('Run `/usage` once in Claude Code and Chutdown will show that reading, ' +
        'with its age - no token, no network and no permission prompt.  \n\n');
    // ...then the state's own sentence, which is the diagnosis and the upgrade in one.
    // Escaped like every other hover here: it names a setting id and a file path, and the
    // dots, underscores and backslashes in those are markdown.
    const why = credText();
    if (why) md.appendMarkdown('_' + shared.mdText(why) + '_  \n');
    if (keychain) md.appendMarkdown('\n[$(gear) chutdown.usageKeychain]' +
        '(command:workbench.action.openSettings?%22chutdown.usageKeychain%22)  \n');
    md.appendMarkdown('\n[$(link-external) claude.ai usage settings](command:chutdown.openUsagePage)');
    setCommand(usageItem, keychain ? KEYCHAIN_SETTING : 'chutdown.openUsagePage');
    // '$(pulse) usage' without the question mark: the meter's own icon, and a label that
    // states what the slot is rather than asking the user something they cannot answer.
    shared.paint(usageItem, {
        text: keychain ? '$(key) usage' : '$(pulse) usage',
        backgroundColor: undefined,
        tooltip: md
    });
}

function renderUsage() {
    const usageItem = shared.items.usage;
    // Re-read the setting: a fetch started before the meter was switched off still
    // lands here, and used to pop the item back into the status bar until the next
    // poll hid it again - a flicker of a feature the user had just turned off.
    if (!shared.cfg().get('usageMeter')) { shared.unpaint(usageItem); return; }
    const { limits, stale } = shownLimits();
    if (!limits.length && !usageError && !credState) return;   // nothing anywhere yet, stay hidden

    // shared.paint skips every write when nothing has changed - a StatusBarItem setter
    // re-renders even when handed the value it already holds, and that re-render closes
    // an open hover. The other half is content that does not churn on its own, which is
    // why the header carries the fetch CLOCK TIME rather than a "12s ago" that would
    // rewrite itself every poll while reading fresh and going stale.

    // ------------------------------------------------- no number, anywhere, from anything
    //
    // What used to sit here was '$(pulse) usage?' with the reason on its hover, and it is
    // the one shape a control is not allowed to take: a permanent slot in the status bar
    // whose click is registered, accepted and does nothing whatever. There is no honest
    // number to put in it either - what the transcripts hold is tokens spent per message,
    // which double-counts without a per-message dedupe, is 98% cache reads (a measure of
    // how long your conversations are, not of what you have spent), cannot see the
    // sub-agent fleet at all, and has no denominator anywhere on disk to turn into the
    // percentage this slot's entire vocabulary is made of. So there is nothing to
    // repurpose it into. What it gets instead is a slot that says so, and whose click
    // goes somewhere real - see paintNothingYet, which also records why the older
    // behaviour (no item at all) turned out to be the worse of the two.
    //
    // `everRead` still matters, just not as a hide. Once a reading has landed the latch
    // holds for the life of the window, so an expired reading is answered with the
    // question mark below rather than by dropping the item and shoving every neighbouring
    // entry along the tray. The item is now contributed from the first poll and never
    // withdrawn, which is one fewer move than before, not one more.
    if (!limits.length) {
        // keychain:off is checked whether or not a reading has ever landed: it is the one
        // state a CLICK can still fix, so it keeps the offer even after an earlier
        // reading has expired. !everRead is the first run, on every platform.
        if (credState === 'keychain:off' || !everRead) { paintNothingYet(usageItem); return; }
        // Nothing to cycle through, so the click goes where the question goes.
        setCommand(usageItem, 'chutdown.openUsagePage');
        shared.paint(usageItem, {
            text: '$(pulse) usage?',
            backgroundColor: undefined,
            tooltip: 'Claude usage unavailable: ' + (usageError || credText()) +
                '\nClick to open the claude.ai usage page.'
        });
        return;
    }
    const order = byTightest(limits);
    const shown = focused(limits);
    const left = pctLeft(shown.percent);
    // ALWAYS labelled now. A bare '62%' used to mean "this is the tightest limit", which
    // asked the reader to know both that rule and which window was currently tightest
    // before the number meant anything - and the label was suppressed in precisely the
    // case where it was hardest to guess. One word is a cheap price for a number that
    // says what it is: '62% 3h20m' is the session with three hours left on it, whether or
    // not anything else is tighter, and '40% Fable' is not mistakable for it.
    const labelled = true;

    const md = new vscode.MarkdownString();
    // The two links below. openSettings is VS Code's own, and the only argument it is ever
    // given here is a literal setting id written in this file - nothing from the endpoint,
    // the account or the disk reaches it.
    md.isTrusted = { enabledCommands: ['chutdown.openUsagePage', 'workbench.action.openSettings'] };
    // Escaped, like every other hover in the extension (shared.js says why). None of
    // these three is text this file wrote:  is built from the account's own
    // subscriptionType,  is title-cased from an ARBITRARY key in the endpoint's
    // JSON by design, and  can carry a server message. isTrusted is scoped to
    // two harmless commands so nothing here could ever fire another, but an unescaped
    // underscore or bracket still garbles the row it lands in.
    const who = shared.mdText(planLabel());
    md.appendMarkdown('**Claude usage**' + (who ? ' - **' + who + '**' : '') +
        (stale ? ' - from Claude Code\'s own cache, ' + ageOf(Date.now() - stale.at) + ' old'
            : ' - what /usage shows, fetched ' + clock(usageFetchedAt)) + '  \n\n');
    // The shown row is marked rather than moved: the hover keeps the server's order, so
    // rows do not shuffle under the pointer as the percentages move. A plain character
    // and not a $(codicon) - hovers here are built without `supportThemeIcons`, so an
    // icon outside a link label would sit there reading "$(pulse)".
    for (const l of limits)
        md.appendMarkdown('`' + bar(l.percent) + '` **' + (l === shown ? '▸ ' : '') +
            shared.mdText(l.name) + '**: ' + pctLeft(l.percent) + '% left' + resetIn(l.resetsAt) + '  \n');
    // The default is the tightest window WITH ROOM, so the only way the default can be
    // anything but the tightest is the tightest being spent - which is what the note says,
    // and the only thing it says: the meter never asserts spentness of a window that has
    // room, because that case cannot reach this branch.
    if (limits.length > 1)
        md.appendMarkdown('\n_Click the meter for the next limit' +
            (focus ? ' - it is showing **' + shared.mdText(shown.name) + '**, not the default.'
                : shown === order[0] ? '.'
                    : ' - it opens past **' + shared.mdText(order[0].name) + '**, which is spent.') +
            '_  \n');
    // One limit is not a cycle. The click used to be wired to it anyway, and stepping
    // through a list of one repainted the identical number - a control that accepts the
    // click and does nothing with it. An account reporting a single window is the ordinary
    // shape of a plan with one limit, not an edge case, so the click gets somewhere to go.
    else md.appendMarkdown('\n_Click to open the claude.ai usage page._  \n');
    // Said once, quietly, because "where is my Fable row?" has a real answer: the server
    // reports a limit window per plan, and this hover shows exactly the ones it reported.
    if (who) md.appendMarkdown('\n_' + who + ' - these are the limits your plan reports; ' +
        'a model your plan has no weekly limit for has no row._  \n');
    if (usageError) md.appendMarkdown('\n_last refresh failed: ' + shared.mdText(usageError) + '_  \n');
    // Why the numbers are not being refreshed, in the same slot and the same voice as a
    // refresh that failed - the difference being that this one is a state and not an
    // error, so it names the thing to change rather than a thing to wait out.
    // Escaped for the same reason the line above it is: the 'nofile' sentence names a
    // resolved PATH, and a Windows one is backslashes and underscores all the way down.
    if (credState) md.appendMarkdown('\n_' + shared.mdText(credText()) + '_  \n');
    if (credState === 'keychain:off')
        md.appendMarkdown('\n[$(gear) chutdown.usageKeychain]' +
            '(command:workbench.action.openSettings?%22chutdown.usageKeychain%22)  \n');
    md.appendMarkdown('\n[$(link-external) claude.ai usage settings](command:chutdown.openUsagePage)');
    // A reading has landed, so the meter is a meter again: whatever the click was pointed
    // at while there was nothing to show, it comes back here.
    setCommand(usageItem, limits.length > 1 ? 'chutdown.cycleUsageFocus' : 'chutdown.openUsagePage');
    shared.paint(usageItem, {
        text: '$(pulse) ' + left + '%' + (labelled ? ' ' + shortName(shown) : ''),
        // Warning colour follows the SHOWN limit, not the account's worst: stepping past
        // a spent window whose reset is days away and keeping its red background would
        // undo the click. The spent row is still on the hover saying so.
        backgroundColor: left <= 10 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined,
        tooltip: md
    });
}

Object.assign(module.exports, { usageTick, cycleUsageFocus, parseLimits, planFrom,
    modelAllowed, modelAvailability, setAvailabilityListener });

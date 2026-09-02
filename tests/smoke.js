// The PUBLIC smoke suite: `npm test` on a fresh clone.
//
// Zero dependencies, no build step, no network, no temp files, nothing spawned and
// nothing launched - it loads the real modules under tests/vscode-stub.js and asserts
// the pure logic they export. It runs anywhere node runs, on any clone, and on the
// group's rented box, which is the whole point of it: package.json's `test` script and
// the `smoke` entry in the root .d8a both have to pass there.
//
// It is NOT the author's full suite (nearly 800 assertions, real processes, real
// transcripts, a temp HOME). That one is still `npm run test:full` where it exists.
// This is the floor: the checks that can be made from a checkout and nothing else.
//
// Adding a case: write a function, register it with `test('what it must do', fn)`.
// A failure prints the case name and the mismatch and the process exits 1.

const path = require('path');
const stub = require('./vscode-stub');

stub.install();                       // BEFORE any require of src/ - see the stub's header

const SRC = path.join(__dirname, '..', 'src');
const terminals = require(path.join(SRC, 'terminals.js'));
const density = require(path.join(SRC, 'density.js'));
const usage = require(path.join(SRC, 'usage.js'));
const win32 = require(path.join(SRC, 'platform', 'win32.js'));

// ---------------------------------------------------------------- the runner

let passed = 0;
const failures = [];
let current = '';

function fail(message) {
    failures.push(current + ': ' + message);
}

function show(value) {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function ok(cond, message) {
    if (cond) { passed++; return true; }
    fail(message);
    return false;
}

function eq(actual, expected, message) {
    if (actual === expected) { passed++; return true; }
    fail(message + ' - expected ' + show(expected) + ', got ' + show(actual));
    return false;
}

function throws(fn, message) {
    try { fn(); } catch (e) { passed++; return e; }
    fail(message + ' - it did not throw');
    return null;
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

// ---------------------------------------------------------------- .terminals

test('a BOM-prefixed JSON file still parses', () => {
    // The BOM is BUILT rather than typed: a literal U+FEFF in this file is invisible,
    // and any editor or tool that strips it would leave the test quietly testing nothing.
    const BOM = String.fromCharCode(0xFEFF);
    const entries = terminals.parseTerminalsFile(BOM + '{ "web": "npm run dev" }');
    eq(entries.length, 1, 'one entry');
    if (!entries.length) return;
    eq(entries[0].name, 'web', 'name');
    eq(entries[0].command, 'npm run dev', 'command');
    eq(entries[0].sub, '', 'no cwd means the workspace root');
});

test('a "// name" key is a note, not a terminal', () => {
    const entries = terminals.parseTerminalsFile('{ "// web": "npm run dev", "api": "npm start" }');
    eq(entries.length, 1, 'the note is skipped');
    if (entries.length) eq(entries[0].name, 'api', 'the real entry survives');
});

test('an object entry keeps its cmd, cwd and port', () => {
    const entries = terminals.parseTerminalsFile(
        '{ "web": { "cmd": "npm run dev", "cwd": "packages/site", "port": 3003 } }');
    eq(entries.length, 1, 'one entry');
    if (!entries.length) return;
    eq(entries[0].command, 'npm run dev', 'command');
    eq(entries[0].sub, 'packages/site', 'cwd');
    eq(entries[0].port, 3003, 'port');
});

test('an impossible port is dropped and the entry survives', () => {
    stub.clearLog();
    const entries = terminals.parseTerminalsFile('{ "web": { "cmd": "npm run dev", "port": 70000 } }');
    eq(entries.length, 1, 'the terminal still launches');
    if (entries.length) eq(entries[0].port, undefined, 'the port is thrown away, not the entry');
    ok(stub.logLines().some((l) => l.indexOf('70000') >= 0), 'and the output channel says so');
});

test('comments and a trailing comma are tolerated', () => {
    const entries = terminals.parseTerminalsFile(
        '{\n  // the site\n  "web": "npm run dev",\n  /* and nothing else */\n}\n');
    eq(entries.length, 1, 'one entry');
    if (entries.length) eq(entries[0].command, 'npm run dev', 'command');
});

test('the legacy line syntax is still read', () => {
    const entries = terminals.parseTerminalsFile('web:3003 @ D8A = npm run dev\n');
    eq(entries.length, 1, 'one entry');
    if (!entries.length) return;
    eq(entries[0].name, 'web:3003', 'the name carries its port in this syntax');
    eq(entries[0].sub, 'D8A', 'the subfolder');
    eq(entries[0].command, 'npm run dev', 'the command');
});

test('a name listed twice is one terminal, not two', () => {
    const json = terminals.parseTerminalsFile(
        '[ { "name": "web", "cmd": "npm run dev" }, { "name": "web", "cmd": "npm start" } ]');
    eq(json.length, 1, 'JSON form: the second is ignored');
    if (json.length) eq(json[0].command, 'npm run dev', 'the first one wins');
    const lines = terminals.parseTerminalsFile('web = npm run dev\nweb = npm start\n');
    eq(lines.length, 1, 'line form: the second is ignored');
});

test('an entry with no command is skipped, loudly', () => {
    stub.clearLog();
    const entries = terminals.parseTerminalsFile('{ "web": { "port": 3003 }, "api": "npm start" }');
    eq(entries.length, 1, 'only the entry that can run');
    ok(stub.logLines().some((l) => l.indexOf('no command') >= 0), 'and it is logged');
});

test('malformed JSON throws a message a person can act on', () => {
    const err = throws(() => terminals.parseTerminalsFile('{ "web": }'), 'a syntax error');
    if (!err) return;
    ok(String(err.message).length > 0, 'the message is not empty');
    // Node phrases JSON errors differently across versions; jsonMessage only rewrites
    // the ones that carry a position, so this is asserted conditionally rather than
    // pinning one runtime's wording.
    if (/position \d+/.test(String(err.message)))
        ok(/\(line \d+, column \d+\)/.test(String(err.message)), 'a position becomes a line and column');
    else passed++;
});

test('looksLikeJson decides on the first real character', () => {
    ok(terminals.looksLikeJson('  // a note\n{ "web": "npm run dev" }'), 'a comment does not hide the brace');
    ok(!terminals.looksLikeJson('web = npm run dev'), 'a line file is not JSON');
});

// ---------------------------------------------------------------- status bar density

test('fit() never trades an ellipsis for a single letter', () => {
    eq(density.fit('recapture', 8), 'recapture', 'nine characters at max 8 stay whole');
    eq(density.fit('codereview5', 8), 'coderev…', 'a real cut wears the ellipsis');
    eq(density.fit('anything', 0), '', 'max 0 is no name at all');
});

test('estimate() charges a launch button for its word only while it keeps one', () => {
    const counts = { buttons: ['opus'], sessions: [], terms: [] };
    eq(density.estimate(density.STEPS[0], counts), 2.5 + 1.5 + 1 + 4, 'full: item + icon + gap + label');
    eq(density.estimate(density.STEPS[1], counts), 2.5 + 1.5, 'letters: item + icon');
});

test('the ladder compacts when the bar runs out of room', () => {
    density.reset();
    eq(density.current().id, 'full', 'it starts at full');
    density.recompute({ buttons: ['opus'], sessions: ['detf'], terms: [] });
    eq(density.current().id, 'full', 'a quiet bar stays full');
    eq(density.buttonText('$(O)', 'opus'), '$(O) opus', 'and the button keeps its word');
    eq(density.sessionText('🟢', 'recapture'), '🟢 recapture', 'and the light keeps its name');

    const many = [];
    for (let i = 0; i < 40; i++) many.push('session' + i);
    density.recompute({ buttons: ['opus'], sessions: many, terms: [] });
    eq(density.current().id, 'bare', 'forty lights past the budget is the last rung');
    eq(density.buttonText('$(O)', 'opus'), '$(O)', 'the button is down to its letter');
    eq(density.sessionText('🟢', 'recapture'), '🟢', 'the light is down to its emoji');
    ok(!density.sessionNameShown('recapture'), 'so the hover has to carry the name');
    density.reset();
});

// ---------------------------------------------------------------- usage meter

test('parseLimits reads the array shape', () => {
    const rows = usage.parseLimits({
        limits: [
            { kind: 'session', percent: 12, resets_at: 'later' },
            { kind: 'weekly_all', percent: 50 },
            { kind: 'weekly_model', scope: { model: { display_name: 'Opus' } }, percent: 7 },
            { kind: 'weekly_all' }
        ]
    });
    eq(rows.length, 3, 'a limit with no percent is not a row');
    if (rows.length < 3) return;
    eq(rows[0].name, 'Session (5h)', 'the session window');
    eq(rows[0].percent, 12, 'its percent');
    eq(rows[0].resetsAt, 'later', 'its reset');
    eq(rows[1].name, 'Weekly - all models', 'the weekly window');
    eq(rows[2].name, 'Weekly - Opus', 'a per-model window is named after the model');
});

test('parseLimits reads the keyed shape, and names a window it has never heard of', () => {
    const rows = usage.parseLimits({
        five_hour: { utilization: 41, resets_at: 'soon' },
        seven_day_opus: null,
        seven_day_frobnicate: { utilization: 3 }
    });
    eq(rows.length, 2, 'a null model is one you have not used, not a row');
    if (rows.length < 2) return;
    eq(rows[0].name, 'Session (5h)', 'five_hour');
    eq(rows[0].percent, 41, 'its utilization is the percent');
    eq(rows[1].name, 'Weekly - Frobnicate', 'an unknown window is named, not dropped');
});

test('parseLimits survives a body that is not one', () => {
    eq(usage.parseLimits(null).length, 0, 'null');
    eq(usage.parseLimits('nonsense').length, 0, 'a string');
    eq(usage.parseLimits({}).length, 0, 'an empty object');
    eq(usage.parseLimits({ five_hour: { utilization: 120 } })[0].percent, 120,
        'a percent over 100 is carried, not thrown');
});

// ---------------------------------------------------------------- the power action

test('the Windows power commands are exactly what shutdown.exe takes', () => {
    eq(win32.powerCommandFor('shutdown', false), 'shutdown /s /t 0', 'shutdown');
    eq(win32.powerCommandFor('shutdown', true), 'shutdown /s /f /t 0', 'shutdown, forced');
    eq(win32.powerCommandFor('restart', true), 'shutdown /r /f /t 0', 'restart, forced');
    eq(win32.powerCommandFor('logoff', true), 'shutdown /l', 'a log out is never forced');
    eq(win32.powerCommandFor('test', true), '', 'test runs no power command at all');
    eq(win32.powerCommandFor('nonsense', false), '', 'and neither does a verb nobody knows');
    ok(win32.powerCommandFor === win32.powerCommand, 'on Windows the two questions have one answer');
});

test('the countdown window is handed a file and a hex token', () => {
    const cmd = win32.countdownCommand('countdown.ps1', 'Chutdown', 'Shutting down', 'shutdown', 5, 'abcQZ');
    ok(cmd.indexOf('-File "countdown.ps1"') >= 0, 'the script is a file argument');
    ok(cmd.indexOf('-Seconds 5') >= 0, 'the seconds');
    ok(/-Token abc$/.test(cmd), 'the token is filtered to hex');
    const none = win32.countdownCommand('countdown.ps1', 'T', 'M', 'shutdown', 5);
    ok(none.indexOf('-Token') < 0, 'no token, no -Token argument');
});

// ---------------------------------------------------------------- the modules load

test('every module the suite touches loads against the stub', () => {
    for (const rel of ['shared.js', 'terminals.js', 'density.js', 'usage.js',
        path.join('platform', 'index.js'), path.join('platform', 'win32.js'),
        path.join('platform', 'darwin.js')]) {
        const mod = require(path.join(SRC, rel));
        ok(mod && typeof mod === 'object', rel + ' loads and exports something');
    }
});

// ---------------------------------------------------------------- go

for (const c of cases) {
    current = c.name;
    try { c.fn(); }
    catch (e) { fail('threw ' + (e && e.stack ? e.stack.split('\n')[0] : String(e))); }
}

for (const f of failures) console.error('FAIL  ' + f);
console.log(passed + ' passed, ' + failures.length + ' failed');
process.exit(failures.length ? 1 : 0);

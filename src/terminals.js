// The .terminals file: turning it into a list of {name, sub, command, port}.
//
// TWO surface syntaxes, one result. The original is one line per terminal:
//
//     web:3003 @ D8A = npm run dev
//
// which packs four things into one line by position, and so has nowhere to put a
// fifth. The JSON form names them instead - it is what the button writes and what
// `.terminals` is registered as (`jsonc`) in the editor:
//
//     {
//       "web": { "cmd": "npm run dev", "cwd": "D8A", "port": 3003 },
//       "hub": "npm start"                    // a string is just the command
//     }
//
// Both are read for ever: a JSON parser is not a reason to invalidate the .terminals
// files people already have. Which syntax a file is in is decided by its first
// non-comment character, not by its name.
//
// Two ways to write a note in the JSON form, because strict JSON has none:
//
//   - a KEY that starts with `//` or `#` is skipped, value and all. That is what the
//     sample uses: it needs no editor support to be legal, nothing underlines it in
//     red, and prefixing an entry's name with `// ` is a real off switch - a server
//     you can park for a week without deleting how it was configured.
//   - `//`, `/* */` and `#` comment SYNTAX is tolerated too, along with trailing
//     commas, for anyone who prefers it (`.terminals` is registered as `jsonc` so
//     VS Code stops calling those an error) - but a file written that way is no
//     longer JSON any other tool will read, which is why the sample stays strict.

const shared = require('./shared');

/// A field can be spelled more than one way - `cmd`/`command`/`run` are the same
/// thing, and being told "unknown field: command" for the obvious spelling is a worse
/// experience than accepting all three.
const CMD_KEYS = ['cmd', 'command', 'run'];
const CWD_KEYS = ['cwd', 'dir', 'folder', 'sub', 'subfolder'];
const NAME_KEYS = ['name', 'label', 'key'];
const KNOWN_KEYS = new Set([...CMD_KEYS, ...CWD_KEYS, ...NAME_KEYS, 'port']);

const pick = (obj, keys) => {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
};

/// `"// anything": …` is a note, not a terminal - the only way to write one that is
/// still strict JSON. It doubles as the off switch: put `// ` in front of an entry's
/// name and it stops launching without losing its command, cwd and port.
const isNoteKey = (key) => /^\s*(\/\/|#)/.test(String(key));

/// "web:3003 @ D8A" -> { name: 'web:3003', sub: 'D8A' }. Shared by both syntaxes: the
/// key of a JSON entry is the same string as the left-hand side of a line, so
/// `"web @ D8A": "npm run dev"` keeps working for anyone converting a file by hand.
function splitName(key) {
    let name = String(key).trim();
    let sub = '';
    const at = name.indexOf('@');
    if (at >= 0) {
        sub = name.slice(at + 1).trim();
        name = name.slice(0, at).trim();
    }
    return { name, sub };
}

/// Ports are validated HERE, not at launch: `net.connect` throws ERR_SOCKET_BAD_PORT
/// synchronously on anything over 65535, and that throw would come out of the poll.
function validPort(port, where) {
    if (port === undefined || port === null || port === '') return undefined;
    const n = typeof port === 'number' ? port : Number(String(port).trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        shared.nlog('.terminals: "' + where + '": ' + JSON.stringify(port) +
            ' is not a port (1-65535) - ignoring it');
        return undefined;
    }
    return n;
}

// ---- the line syntax --------------------------------------------------------

function parseLineTerminals(text) {
    const entries = [];
    // The NAME is the key - of the record, of the status bar item, of the click that
    // reveals the tab. Two lines sharing one is not two terminals, it is one terminal
    // and one ghost, so the repeat is dropped here rather than silently launched
    // (sessions get the same treatment a rung up, in shared.uniqueName).
    const names = new Set();
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const { name, sub } = splitName(line.slice(0, eq));
        const command = line.slice(eq + 1).trim();
        if (!name || !command) continue;
        if (names.has(name)) { shared.nlog('.terminals: "' + name + '" is listed twice - the second one is ignored'); continue; }
        names.add(name);
        entries.push({ name, sub, command });
    }
    return entries;
}

// ---- the JSON syntax --------------------------------------------------------

/// Blank out comments and trailing commas IN PLACE - each one replaced by spaces of
/// the same width, newlines kept. JSON.parse then reports a syntax error at an offset
/// that still points at the character the user is looking at in their editor, which is
/// the whole reason this does not simply delete them.
function relaxJson(text) {
    const out = text.split('');
    let i = 0, lastCode = -1;   // index of the last non-whitespace character seen
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k++)
            if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {                                   // a string: skipped whole
            i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === '"') { i++; break; }
                i++;
            }
            lastCode = i - 1;
            continue;
        }
        if ((c === '/' && text[i + 1] === '/') || c === '#') {   // # is the old file's mark
            let end = text.indexOf('\n', i);
            if (end < 0) end = text.length;
            blank(i, end); i = end; continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            let end = text.indexOf('*/', i + 2);
            end = end < 0 ? text.length : end + 2;
            blank(i, end); i = end; continue;
        }
        // A closer straight after a comma (whitespace and comments aside) means that
        // comma was trailing - blank it, and JSON.parse never sees it.
        if ((c === '}' || c === ']') && lastCode >= 0 && out[lastCode] === ',') out[lastCode] = ' ';
        if (!/\s/.test(c)) lastCode = i;
        i++;
    }
    return out.join('');
}

const looksLikeJson = (text) => /^[[{]/.test(relaxJson(text).trim());

/// JSON.parse says "position 214"; an editor says "line 9". Translate, so the text in
/// the error notification is something a person can act on.
function jsonMessage(src, err) {
    const m = /position (\d+)/.exec(err.message);
    if (!m) return err.message;
    const upto = src.slice(0, Number(m[1]));
    const line = upto.split('\n').length;
    const col = upto.length - (upto.lastIndexOf('\n') + 1) + 1;
    return err.message.replace(/\s*in JSON at position \d+.*$/, '') +
        ' (line ' + line + ', column ' + col + ')';
}

/// One entry from a key/value pair. Returns null - with a line in the output channel
/// saying why - for anything that could not become a terminal, because a `.terminals`
/// entry that silently does not launch is the failure this whole file exists to avoid.
function jsonEntry(key, value, names) {
    let raw = key, command, cwd, port;
    if (typeof value === 'string' || typeof value === 'number') {
        command = String(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (raw === undefined) raw = pick(value, NAME_KEYS);
        command = pick(value, CMD_KEYS);
        cwd = pick(value, CWD_KEYS);
        port = value.port;
        for (const k of Object.keys(value))
            if (!KNOWN_KEYS.has(k))
                shared.nlog('.terminals: "' + raw + '": unknown field "' + k +
                    '" - expected one of ' + [...KNOWN_KEYS].join(', '));
    } else {
        shared.nlog('.terminals: "' + raw + '": expected a command string or an object, got ' +
            (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value));
        return null;
    }
    if (raw === undefined || String(raw).trim() === '') {
        shared.nlog('.terminals: an entry has no name - give it one (the name is its status bar light).');
        return null;
    }
    const { name, sub } = splitName(raw);
    const folder = cwd === undefined ? sub : String(cwd).trim();
    if (!name) { shared.nlog('.terminals: an entry has no name before its "@" - skipped.'); return null; }
    if (typeof command !== 'string' || !command.trim()) {
        shared.nlog('.terminals: "' + name + '" has no command - add "cmd": "npm run dev".');
        return null;
    }
    if (names.has(name)) {
        shared.nlog('.terminals: "' + name + '" is listed twice - the second one is ignored');
        return null;
    }
    names.add(name);
    return { name, sub: folder, command: command.trim(), port: validPort(port, name) };
}

/// Throws on malformed JSON - the caller turns that into a notification. Anything that
/// parses but does not describe a terminal is logged and skipped instead: one bad
/// entry should not stop the other five servers from starting.
function parseJsonTerminals(text) {
    const src = relaxJson(text);
    let data;
    try { data = JSON.parse(src); }
    catch (e) { throw new Error(jsonMessage(src, e)); }
    // `{ "terminals": ... }` is accepted so the file can carry a "$schema" line (and
    // whatever settings a later version puts beside it) without those keys reading as
    // terminals named "$schema".
    if (data && !Array.isArray(data) && typeof data === 'object' && data.terminals !== undefined)
        data = data.terminals;
    const names = new Set();
    const entries = [];
    if (Array.isArray(data)) {
        for (const item of data) {
            const e = jsonEntry(undefined, item, names);
            if (e) entries.push(e);
        }
    } else if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
            if (key === '$schema' || isNoteKey(key)) continue;
            const e = jsonEntry(key, value, names);
            if (e) entries.push(e);
        }
    } else {
        throw new Error('expected an object of "name": "command" pairs, or an array of entries');
    }
    return entries;
}

/// The one entry point: which syntax a file is written in is its own business.
///
/// The BOM is stripped here, once, because it defeated exactly one of the two syntaxes
/// and did it invisibly. `looksLikeJson` passes on a BOM'd file - String.trim() counts
/// U+FEFF as whitespace - but relaxJson preserves it (it replaces comments with spaces
/// rather than deleting them, so every offset still points at what the editor shows),
/// and JSON.parse then died on the very first character with a message carrying no
/// `position`, which jsonMessage cannot translate into a line and column. The user saw
/// an unreadable error naming no location, and every entry in the file was lost. The
/// line syntax never noticed - it trims each line itself - so this only ever bit files
/// something else had written: PowerShell `Out-File -Encoding utf8`, or an editor set
/// to `files.encoding: utf8bom`. The Create button writes clean UTF-8.
function parseTerminalsFile(text) {
    const src = String(text).replace(/^﻿/, '');
    return looksLikeJson(src) ? parseJsonTerminals(src) : parseLineTerminals(src);
}

/// The sample the button writes - strict JSON, so no editor anywhere underlines it in
/// red. Its notes are `//`-prefixed KEYS, which is also how the four examples ship
/// switched off: a file that launched four imaginary servers the moment it was created
/// would be worse than an empty one, and "delete the `// ` from the front" is a
/// shorter instruction than any comment syntax.
///
/// The examples exist to settle the one thing that is easy to read wrong: the KEY IS A
/// NAME, NOT A FOLDER. `"web": "npm run dev"` runs in the workspace root like every
/// other entry with no `cwd`; the folder is the `cwd` field and nothing else. Hence a
/// root one, a root one with a port, and two in subfolders - the last named nothing
/// like its folder, so the two cannot be confused for each other.
///
/// Half the notes are addressed to an AI AGENT, in those words, because it is the most
/// frequent reader of this file and the one whose default move is wrong: told to bounce
/// a dev server it kills the process and runs the command again in a shell of its own,
/// which produces a server outside the editor's terminals - no tab, no light, no log in
/// the hover, and gone the moment the session ends. The one line that avoids all of that
/// is `/restart?name=…&ws=…`, so it is written out in full with this folder already in
/// it, next to what each parameter is for. `ws=` in particular is not guessable and not
/// optional-looking: without it the link lands in whatever window was last active.
///
/// VS Code addresses a URI handler as vscode://<publisher>.<name>/…, and this string is
/// written into the sample file every new user gets. Hard-coded, it goes stale silently:
/// change the publisher and the documented command still LOOKS right, still opens VS
/// Code, and is then routed to an extension id that no longer exists - no error anywhere,
/// just a restart command that quietly does nothing. The real id is on the context we
/// already keep, so it cannot drift; the literal is only the fallback for a sample
/// written before activate() ran, which the smoke suite is the only caller of.
function extensionId() {
    const ctx = shared.state.extContext;
    return (ctx && ctx.extension && ctx.extension.id) || 'd8a.chutdown';
}

function sampleJson(root) {
    // The restart line is written with THIS folder already in it, so it is a command
    // to run rather than a template to fill in. Forward slashes and %20 keep it
    // readable where a URI-encoded Windows path would not be; path.resolve on the
    // other end puts the backslashes back.
    const ws = String(root || '<this folder>').replace(/\\/g, '/').replace(/ /g, '%20').replace(/&/g, '%26');
    const note = (key, value) => '  ' + JSON.stringify('// ' + key) + ': ' + JSON.stringify(value) + ',';
    return [
        '{',
        note('what this is', 'one terminal per entry - the .terminals button launches them all'),
        note('the shapes', 'NAME: command   or   NAME: { cmd, cwd, port }'),
        note('the name', 'just a label - it names the terminal tab and its status bar light'),
        note('the folder', 'cwd, relative to this file. Without it an entry runs in the workspace root'),
        note('a note, or an off switch', 'any key starting with // is ignored - like the four below'),
        '',
        note('FOR THE AGENT WORKING HERE: how to reset one of these',
            'do not kill it and start your own copy in your own shell - that copy dies with your session and is invisible here. Run a line below instead and the editor restarts the entry itself: same terminal tab, port taken back first, light and log still pointing at it.'),
        note('  reset one entry',
            'code --open-url "vscode://' + extensionId() + '/restart?name=web&ws=' + ws + '"'),
        note('  name= is a key from this file', '"web", or its full name "web:3000" - case-insensitive. Drop name= entirely and every entry restarts.'),
        note('  /start and /stop, same shape', '/start leaves an entry that is already answering alone; /stop is Ctrl+C, then the port if Ctrl+C is ignored, tab left open.'),
        note('  ws= is which window', 'a vscode:// link goes to the LAST ACTIVE editor window - one open on another folder sees this and ignores it. Keep it as written.'),
        note('  how to tell it worked', 'the command prints nothing either way. The light goes amber then green, and every failure (unknown name, missing folder) is a line in View -> Output -> Chutdown. Never a dialog.'),
        note('  on macOS, once', 'the Command Palette -> "Shell Command: Install \'code\' command in PATH", or `code` is not on PATH and these lines do nothing at all.'),
        note('...or from the editor', 'the Command Palette -> Chutdown: Restart All Terminals'),
        '',
        '  "// dev": "npm run dev",',
        '  "// web": { "cmd": "npm run dev", "port": 3000 },',
        '  "// api": { "cmd": "npm run dev", "cwd": "packages/api", "port": 4000 },',
        '  "// d8a": { "cmd": "npm start", "cwd": "D8A" }',
        '}',
        ''
    ].join('\n');
}

Object.assign(module.exports, { parseTerminalsFile, looksLikeJson, sampleJson });

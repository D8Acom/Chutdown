// A stand-in for the `vscode` module, so the real src/*.js files can be loaded
// outside the editor.
//
// Every module under src/ opens with `const vscode = require('vscode')`
// (src/shared.js line 5, src/usage.js line 8), and that module only exists inside
// the extension host: on a plain `node` process the require throws
// MODULE_NOT_FOUND before a single line of our own code runs. So the public smoke
// suite installs this object under that name FIRST, then requires the real files.
//
// Deliberately small. It stubs the five things the modules the public suite
// exercises actually touch, and nothing else:
//
//   workspace.getConfiguration(section)  -> a config whose get() answers the
//                                           caller's own default (or undefined),
//                                           which is what makes the tests read the
//                                           shipped defaults rather than a machine's
//                                           settings.json
//   workspace.workspaceFolders           -> undefined (shared.firstRoot then falls
//                                           back to os.homedir())
//   window.createOutputChannel(name)     -> a channel that keeps its lines in memory,
//                                           so shared.nlog() works and a test can read
//                                           back what was logged
//   ThemeIcon / ThemeColor               -> id/colour carriers (shared.tabMark)
//   MarkdownString                       -> the hover builder (src/usage.js)
//
// Anything a module reaches for that is NOT here throws a TypeError naming the
// missing member, which is the honest failure: it means the suite has grown past
// what this stub covers and the stub needs a line, not that the extension is broken.

const Module = require('module');

class ThemeIcon {
    constructor(id, color) { this.id = id; this.color = color; }
}

class ThemeColor {
    constructor(id) { this.id = id; }
}

class MarkdownString {
    constructor(value, supportThemeIcons) {
        this.value = value === undefined ? '' : String(value);
        this.supportThemeIcons = !!supportThemeIcons;
        this.isTrusted = false;
    }
    appendText(text) { this.value += String(text == null ? '' : text); return this; }
    appendMarkdown(md) { this.value += String(md == null ? '' : md); return this; }
    appendCodeblock(code, lang) {
        this.value += '\n```' + (lang || '') + '\n' + String(code == null ? '' : code) + '\n```\n';
        return this;
    }
}

/// Every channel ever created, by name - `lines` is what nlog() wrote.
const channels = new Map();

function createOutputChannel(name) {
    if (channels.has(name)) return channels.get(name);
    const channel = {
        name,
        lines: [],
        append(text) { channel.lines.push(String(text)); },
        appendLine(text) { channel.lines.push(String(text)); },
        replace(text) { channel.lines = [String(text)]; },
        clear() { channel.lines = []; },
        show() {},
        hide() {},
        dispose() { channels.delete(name); }
    };
    channels.set(name, channel);
    return channel;
}

/// What shared.nlog() has logged since the last clearLog(). The suite asserts on
/// these for the cases whose whole contract is "skip it and SAY so".
function logLines() {
    const channel = channels.get('Chutdown');
    return channel ? channel.lines.slice() : [];
}

function clearLog() {
    const channel = channels.get('Chutdown');
    if (channel) channel.lines = [];
}

/// `settings` lets a test pin one value; everything else answers the caller's default,
/// which is the shipped default because every reader in src/ passes one or falls back
/// to a constant of its own (src/density.js budget(), for instance).
let settings = {};

function setSettings(values) { settings = values || {}; }

function getConfiguration(section) {
    const prefix = section ? section + '.' : '';
    return {
        get(key, fallback) {
            const full = prefix + key;
            if (Object.prototype.hasOwnProperty.call(settings, full)) return settings[full];
            if (Object.prototype.hasOwnProperty.call(settings, key)) return settings[key];
            return fallback;
        },
        has(key) {
            return Object.prototype.hasOwnProperty.call(settings, prefix + key) ||
                Object.prototype.hasOwnProperty.call(settings, key);
        },
        inspect() { return undefined; },
        update() { return Promise.resolve(); }
    };
}

const vscode = {
    version: '1.93.0-stub',
    workspace: {
        workspaceFolders: undefined,
        getConfiguration,
        onDidChangeConfiguration() { return { dispose() {} }; }
    },
    window: {
        createOutputChannel,
        showInformationMessage() { return Promise.resolve(undefined); },
        showWarningMessage() { return Promise.resolve(undefined); },
        showErrorMessage() { return Promise.resolve(undefined); }
    },
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { file: (p) => ({ scheme: 'file', fsPath: String(p), path: String(p) }) }
};

/// Put the stub under the name 'vscode' for every require that follows, including the
/// ones the src modules make of each other. Module._load is patched rather than
/// require.cache seeded, because there is no resolvable path for 'vscode' to key the
/// cache on - resolution itself is what fails outside the editor.
let installed = false;

function install() {
    if (installed) return vscode;
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return load.apply(this, arguments);
    };
    installed = true;
    return vscode;
}

module.exports = { vscode, install, logLines, clearLog, setSettings, channels };

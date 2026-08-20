// How much the status bar is allowed to say - one number, read by every painter.
//
// A busy afternoon is four launch buttons, a dozen session lights and three dev servers,
// and the status bar is one line with no scroll: VS Code simply drops whatever does not
// fit, rightmost first, and the things it drops are ours - the idle entry, the usage
// meter, the batch lights. Nothing in the extension API says how wide the bar is, so
// this cannot measure; it ESTIMATES, in character cells, what the variable items would
// take, and walks down a ladder of ever-terser renderings until the estimate fits the
// budget (`chutdown.statusBarBudget`, default 120, 0 = never compact):
//
//   0  full       $(O) opus   🟢 recapture    🟢 detf     - as always
//   1  letters    $(O)        🟢 recapture    🟢 detf     - buttons lose their labels
//   2  short      $(O)        🟢 recaptu…     🟢 detf     - names cut to 8
//   3  shorter    $(O)        🟢 reca…        🟢 detf     - names cut to 5
//   4  lights     $(O)        🟢              🟢 detf     - session lights are just lights
//   5  bare       $(O)        🟢              🟢          - and so are the batch lights
//
// Every painter asks this module for its text instead of building it, so the three
// surfaces shrink in the same order at the same moment. The level is recomputed once a
// poll by lights.renderSessions - the one place that knows which sessions are lit - and
// when it moves, that render repaints the buttons and the batch lights too. Whatever a
// light stops saying, its hover still says in full.

const shared = require('./shared');

// The ladder. `names` / `terms` are the longest a session / batch label may be at that
// step (0 = light only), `labels` whether a launch button keeps its word.
const STEPS = [
    { id: 'full',    labels: true,  names: 14, terms: 14 },
    { id: 'letters', labels: false, names: 14, terms: 14 },
    { id: 'short',   labels: false, names: 8,  terms: 8 },
    { id: 'shorter', labels: false, names: 5,  terms: 5 },
    { id: 'lights',  labels: false, names: 0,  terms: 5 },
    { id: 'bare',    labels: false, names: 0,  terms: 0 }
];

// The cell model. A status bar item is its text plus ~5px of padding a side and a gap,
// which at the 12px status bar font is about two and a half characters; an emoji is two
// cells wide, a codicon/letter glyph about one and a half, and the space between a mark
// and its word one. Calibrated against media/screenshots/statusbar.png, not measured.
const ITEM = 2.5, EMOJI = 2, ICON = 1.5, GAP = 1;

const DEFAULT_BUDGET = 120;

let level = 0;

/// `max` cells of a name, with an ellipsis when it had to be cut - "codereview5" at 8 is
/// "coderev…", not "coderevi", so a cut word never passes for a whole one. Nothing is cut
/// to lose a single character: at max 8, "recapture" (9) keeps its tail rather than wear
/// an ellipsis in place of one letter. 0 is "no name at all".
function fit(name, max) {
    const s = String(name || '');
    if (max <= 0) return '';
    if (s.length <= max + 1) return s.slice(0, max + 1);
    return s.slice(0, Math.max(1, max - 1)) + '…';
}

function estimate(step, counts) {
    let w = 0;
    for (const label of counts.buttons)
        w += ITEM + ICON + (step.labels ? GAP + label.length : 0);
    for (const name of counts.sessions) {
        const t = fit(name, step.names);
        w += ITEM + EMOJI + (t ? GAP + t.length : 0);
    }
    for (const label of counts.terms) {
        const t = fit(label, step.terms);
        w += ITEM + EMOJI + (t ? GAP + t.length : 0);
    }
    return w;
}

function budget() {
    const raw = shared.cfg().get('statusBarBudget');
    const n = Number(raw);
    if (raw === undefined || raw === null || !isFinite(n)) return DEFAULT_BUDGET;
    return Math.max(0, n);
}

/// Pick the first step whose estimate fits the budget - the last one if none does - and
/// say whether that moved the level. `counts` is {buttons, sessions, terms}: arrays of
/// the labels each painter would write at full size. Budget 0 never compacts.
function recompute(counts) {
    const b = budget();
    let next = 0;
    if (b > 0) {
        next = STEPS.length - 1;
        for (let i = 0; i < STEPS.length; i++)
            if (estimate(STEPS[i], counts) <= b) { next = i; break; }
    }
    const moved = next !== level;
    if (moved) shared.nlog('density: ' + STEPS[level].id + ' -> ' + STEPS[next].id +
        ' (' + counts.buttons.length + ' button(s), ' + counts.sessions.length +
        ' light(s), ' + counts.terms.length + ' terminal(s), budget ' + b + ')');
    level = next;
    return moved;
}

function step() { return STEPS[level]; }

/// A launch button: the letter, and its word while there is room for one.
function buttonText(icon, label) {
    return step().labels ? icon + ' ' + label : icon;
}

/// A session light: the emoji, and as much of the name as this level allows.
function sessionText(emoji, name) {
    const t = fit(name, step().names);
    return t ? emoji + ' ' + t : emoji;
}

/// A batch terminal light, likewise.
function termText(emoji, label) {
    const t = fit(label, step().terms);
    return t ? emoji + ' ' + t : emoji;
}

/// Is this name shown whole right now? When it is not, the hover has to carry it.
function sessionNameShown(name) { return fit(name, step().names) === String(name || ''); }
function termNameShown(label) { return fit(label, step().terms) === String(label || ''); }

/// For the smoke test, and for anyone reading the output channel.
function current() { return { level, id: STEPS[level].id }; }
function reset() { level = 0; }

Object.assign(module.exports, {
    STEPS, DEFAULT_BUDGET, fit, estimate, recompute, current, reset,
    buttonText, sessionText, termText, sessionNameShown, termNameShown
});

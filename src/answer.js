// Answering a prompt FOR you.
//
// A session blocked on a prompt - a multiple-choice question, a plan approval, a
// permission prompt - stops dead until a human presses a key. That is exactly right while
// you are sitting there, and useless when you are not: the whole premise of the armed gear
// is that you walked away, and a run that stopped on question two at 11pm has wasted the
// night whatever the gear was set to.
//
// So each gear can be told to answer for you. After `autoAnswerMinutes` with nobody
// touching it, Chutdown types ONE Enter into that session's tab, which takes whichever
// option the dialog has highlighted - the first one, and by convention the recommended
// one. Nothing else is typed, ever: no arrow keys, no text, no second press.
//
// Said plainly, because the default scope is `all`: a PERMISSION prompt is answered too,
// and what a permission prompt has highlighted is yes. That is deliberate - it is what
// "keep going while I am asleep" means - but it is unattended approval of whatever Claude
// asked for, so two things bound it. `autoAnswerScope: "questions"` narrows it to
// multiple-choice questions and leaves permissions, plans and sandbox requests sitting
// there; and every gear ships OFF except the armed one, where nobody is at the keyboard by
// definition.
//
// WHICH KIND of prompt is up comes from Claude Code's own session file, not from guessing:
// `waitingFor` sits beside `status: "waiting"` and says "input needed" for a question,
// "permission prompt" for a tool permission or a plan approval, plus "sandbox request",
// "worker request", "goal proposal" and "dialog open" (scan.js reads it). The transcript
// cannot answer this - it does not record a question until after it has been answered.

const shared = require('./shared');
const claude = require('./claude');

/// The gear this window is in. Published by shutdown.js rather than read from it: the
/// hover asks this from lights.js, and lights.js requiring shutdown.js would close a
/// circle that neither module needs.
function gear() { return shared.state.gear || 'off'; }

/// One setting per gear, because the four are four different situations: `off` and
/// `sound` are gears you sit next to, `notify` and the armed action are gears you walk
/// away from. Only the armed one defaults to answering.
const GEAR_SETTING = {
    off: 'autoAnswerOff', sound: 'autoAnswerSound',
    notify: 'autoAnswerNotify', armed: 'autoAnswerShutdown',
};

function onFor(g) { return shared.cfg().get(GEAR_SETTING[g]) === true; }

/// How long a prompt is left for a human before Chutdown takes it. Its own setting, not
/// `questionMinutes`: that one is the armed gear's patience with a question it is waiting
/// BEHIND, and wanting the shutdown to give up after 2 minutes is not the same as wanting
/// a keystroke sent after 2 minutes.
function delayMs() {
    const n = Number(shared.cfg().get('autoAnswerMinutes'));
    return Math.max(0, isFinite(n) ? n : 5) * 60_000;
}

/// `all` - anything the session is blocked on, permission prompts included.
/// `questions` - only a multiple-choice question, which is the one kind of prompt where
/// the highlighted option is a recommendation rather than a grant.
function scope() { return shared.cfg().get('autoAnswerScope') === 'questions' ? 'questions' : 'all'; }

/// The CLI's own word for a question with options on screen.
const QUESTION = 'input needed';

function inScope(s) { return scope() === 'all' || s.waitingFor === QUESTION; }

/// What the prompt on screen is, in words the hover can use. An unknown value - a kind
/// this CLI grew after this was written - is described rather than renamed, on the same
/// rule scan.js applies to `status`: what we do not recognise, we do not reinterpret.
function whatIsUp(s) {
    if (!s || !s.waiting) return '';
    if (s.waitingFor === QUESTION) return 'a question';
    if (s.waitingFor === 'permission prompt') return 'a permission prompt or a plan';
    return s.waitingFor ? 'a ' + s.waitingFor : 'a prompt';
}

/// How long until this session gets answered: milliseconds, 0 for "now", or null when it
/// is not going to be - which is the ordinary case and is why the hover has something to
/// say either way.
function countdown(s, now) {
    now = now || Date.now();
    if (!s || !s.waiting) return null;             // not blocked on anything
    if (!onFor(gear())) return null;               // this gear leaves prompts alone
    if (!inScope(s)) return null;                  // narrowed to questions, and this is not one
    // Only the window whose tab it is may type into it. A session running in another
    // window - or in a plain terminal we cannot see - is that window's to answer, and a
    // shell VS Code revived empty after a quit has nothing listening in it at all.
    if (!claude.terminalFor(s.id)) return null;
    // Answered already: latched against the moment the CLI said it was waiting, so the
    // NEXT prompt (a new statusUpdatedAt) is answerable again while a dialog that ignored
    // our Enter - an "input needed" that wants typed text, say - is never hammered.
    if (s.answeredFor && s.answeredFor === s.waitingSince) return null;
    return Math.max(0, (s.waitingSince || now) + delayMs() - now);
}

/// The poll's pass over the watched sessions. Called from shutdown.tick BEFORE the gear's
/// own early return, because `off` is one of the four gears this can be switched on for.
function pass(sessions) {
    for (const s of sessions || []) {
        const left = countdown(s);
        if (left === null || left > 0) continue;
        answer(s);
    }
}

/// One Enter, into one tab. Latched before the send rather than after: a throw from
/// sendText must not leave a session that gets a keystroke on every poll for ever.
function answer(s) {
    const term = claude.terminalFor(s.id);
    if (!term) return false;
    s.answeredFor = s.waitingSince;
    s.answeredAt = Date.now();
    s.answeredWhat = whatIsUp(s);
    try {
        // A bare carriage return, with no newline of VS Code's own added: the same shape
        // batch.js sends Ctrl+C with, because a TUI wants the keystroke and not a line.
        term.sendText('\r', false);
    } catch (e) {
        shared.nlog('auto-answer: could not type into ' + (s.name || s.id.slice(0, 8)) + ' - ' +
            (e && e.message ? e.message : e));
        return false;
    }
    shared.nlog('auto-answer: ' + (s.name || s.id.slice(0, 8)) + ' had ' + s.answeredWhat +
        ' up for ' + shared.coarse(Date.now() - (s.waitingSince || Date.now())) +
        ' - took the highlighted option (' + gear() + ' gear)');
    return true;
}

/// The session hover's line. Present whenever there is something to say - what is going to
/// happen to a prompt that is up, or what happened to one that was answered - and empty
/// the rest of the time, which is most of it.
///
/// `coarse`, not `humanize`: a hover whose text changes is a hover VS Code closes, and a
/// countdown to the second would shut it every five seconds while it was being read.
function hoverLine(s) {
    if (!s) return '';
    if (s.waiting) {
        const left = countdown(s);
        if (left === null) {
            if (!onFor(gear())) return '_Left for you - the **' + gear() + '** gear does not answer prompts._';
            if (!inScope(s)) return '_Left for you - **autoAnswerScope** is questions only, and this is ' +
                whatIsUp(s) + '._';
            if (s.answeredFor === s.waitingSince) return '_Answered once already - this one wants more than Enter._';
            return '_Left for you._';
        }
        return '_Chutdown answers this in **' + (left < 60_000 ? 'under a minute' : shared.coarse(left)) +
            '** - the highlighted option._';
    }
    // Just after the fact: whoever comes back deserves to be told that a machine pressed a
    // key on their behalf, and which key it was.
    if (s.answeredAt && Date.now() - s.answeredAt < 10 * 60_000)
        return '_Chutdown answered ' + (s.answeredWhat || 'a prompt') + ' ' +
            shared.coarse(Date.now() - s.answeredAt) + ' ago - the highlighted option._';
    return '';
}

/// The gear hover's line: what this gear does about a session that stops to ask something.
/// Stated in every gear, including the ones that do nothing, because "it will answer for
/// me" and "it will sit there" are both things worth knowing before you walk away.
function gearLine(mode) {
    const g = mode || gear();
    if (!onFor(g)) return '**Prompts:** left for you - this gear never answers one.';
    const mins = Math.round(delayMs() / 60_000);
    const when = mins <= 0 ? 'straight away' : 'after **' + mins + ' min**';
    return '**Prompts:** answered for you ' + when + ' - one Enter, taking the option the dialog has ' +
        'highlighted' + (scope() === 'questions'
            ? ', and only for a multiple-choice question (permissions and plans are left alone).'
            : ', for anything a session is blocked on - **including permission prompts and plans**.');
}

Object.assign(module.exports, { pass, answer, countdown, hoverLine, gearLine, whatIsUp, onFor, gear });

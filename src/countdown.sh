#!/bin/sh
# The armed shutdown's countdown, as a DESKTOP window - the Linux third of
# platform.countdownCommand(). It is built by src/platform/darwin.js, which is the module
# index.js hands every platform that is not Windows; src/countdown.ps1 is the Windows
# sibling, and darwin.js builds the macOS window inline as AppleScript rather than from a
# file.
#
# VS Code's own countdown notification is only any use if you are looking at VS Code, and
# the whole premise of the armed gear is that you are not. So the countdown also comes up
# as a window of its own, ticking every second, with a Cancel button.
#
# A FILE rather than an inline -c string, for the same reason the Windows half is one: a
# feeder loop piped into a dialog does not survive being flattened into one shell line.
# Run as:
#
#   sh countdown.sh --seconds 120 --title T --message M --action shutdown --token abc123
#
# THE ANSWER, and it is the same contract on all three platforms:
#   0  the countdown ran out - and nothing else exits 0
#   3  the user pressed "<action> now": skip the rest of the WAIT, not the checks
#   1  cancelled - the Cancel button, Escape, or closing the window
#
# The two nonzero answers each print CHUTDOWN:NOW:<token> or CHUTDOWN:CANCEL:<token>, and
# that line is what the extension actually reads. A bare exit code is provenance-free -
# a missing zenity, a GTK that could not parse the options, a wayland session with no
# portal are all just numbers - so nonzero with NEITHER token means "no window ever
# appeared", and the machine stays on without anyone having cancelled anything.
#
# Which is why "no window appeared" is worked at, not assumed away:
#   - no DISPLAY and no WAYLAND_DISPLAY exits 127 before anything is launched, because a
#     dialog tool with nowhere to draw exits 1, which would otherwise read as a cancel.
#   - a dialog that came back in under a second did not have time to be clicked, so that
#     is treated as a launch failure too, again rather than as a cancel.
# Both keep the machine on either way; the difference is whether the extension latches the
# window off for the session (a failure) or disarms the gear (a person said no).

set -u

SECS=120
TITLE='Chutdown'
MESSAGE='Every Claude session has finished.'
ACTION='shutdown'
TOKEN=''

while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || break
    case "$1" in
        --seconds) SECS="$2" ;;
        --title)   TITLE="$2" ;;
        --message) MESSAGE="$2" ;;
        --action)  ACTION="$2" ;;
        --token)   TOKEN="$2" ;;
    esac
    shift 2
done

# Digits or the default: everything below does arithmetic on it, and `[ x -lt 1 ]` on a
# word is a syntax error that would exit nonzero with no token - i.e. it would read as a
# window that never appeared, from an argument we control.
case "$SECS" in ''|*[!0-9]*) SECS=120 ;; esac
[ "$SECS" -lt 1 ] && SECS=1

NOW_LABEL="$ACTION now"
CANCEL_LABEL='Cancel - stay on'
TEXT="$MESSAGE This machine runs $ACTION in ${SECS}s."

say_now()    { printf 'CHUTDOWN:NOW:%s\n' "$TOKEN"; exit 3; }
say_cancel() { printf 'CHUTDOWN:CANCEL:%s\n' "$TOKEN"; exit 1; }
no_window()  { exit 127; }

[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || no_window

started_at=$(date +%s 2>/dev/null || echo 0)
# A second or less means the tool exited on its own - it was never on screen long enough
# to be clicked, whatever its exit code says. A dialog tool that cannot draw ("cannot open
# display", a wayland session with no portal) exits 1, the same code Cancel leaves, and
# nothing but the clock tells them apart.
#
# The bound is one second and not less because of the feeder below: it writes, sleeps a
# second, and only then discovers the broken pipe, so even an instant failure takes about
# that long to come back. The trade is deliberate and this way round - a human who hits
# Cancel inside the first second is read as a window that never appeared, which leaves the
# machine on and the gear armed, while the reverse mistake would have every armed run
# cancel itself against a zenity that is simply not working and the gear would never fire.
too_fast() {
    now=$(date +%s 2>/dev/null || echo 0)
    [ "$started_at" -gt 0 ] && [ "$((now - started_at))" -le 1 ]
}

# ---- zenity: the ticking one -------------------------------------------------------
# --progress redraws, so this is the only one of the three platforms' windows besides
# Windows' that can actually count down. The feeder writes a percentage and a "# text"
# line per second; --auto-close ends it at 100, which is the run-out path and the only
# way zenity exits 0 here. Cancel and the extra button both exit 1, and are told apart by
# what zenity printed: the extra button echoes its own label.
if command -v zenity >/dev/null 2>&1; then
    out=$(mktemp 2>/dev/null) || out="/tmp/chutdown.$$"
    feed() {
        i=0
        while [ "$i" -lt "$SECS" ]; do
            printf '%s\n' "$((i * 100 / SECS))"
            printf '# %s This machine runs %s in %ss.\n' "$MESSAGE" "$ACTION" "$((SECS - i))"
            sleep 1
            i=$((i + 1))
        done
        printf '100\n'
    }
    feed | zenity --progress --title="$TITLE" --text="$TEXT" --percentage=0 --auto-close \
        --cancel-label="$CANCEL_LABEL" --extra-button="$NOW_LABEL" >"$out" 2>/dev/null
    rc=$?
    # 255 is GTK refusing the option list, which is what an older zenity without
    # --extra-button does. Retry once without it rather than losing the window entirely:
    # the countdown and its Cancel are worth more than the "now" shortcut.
    if [ "$rc" -ge 2 ]; then
        feed | zenity --progress --title="$TITLE" --text="$TEXT" --percentage=0 --auto-close \
            --cancel-label="$CANCEL_LABEL" >"$out" 2>/dev/null
        rc=$?
    fi
    answer=$(cat "$out" 2>/dev/null)
    rm -f "$out" 2>/dev/null
    [ "$rc" -eq 0 ] && exit 0
    [ "$rc" -ge 2 ] && no_window
    printf '%s' "$answer" | grep -qF -- "$NOW_LABEL" && say_now
    too_fast && no_window
    say_cancel
fi

# ---- kdialog: the KDE fallback -----------------------------------------------------
# No progress dialog with buttons here, so the deadline is stated rather than ticked (the
# same trade the macOS dialog makes) and the run-out is us taking the window away. Yes is
# the "now" button because kdialog gives Yes exit 0 and everything else nonzero, which is
# the shape the two answers already have.
if command -v kdialog >/dev/null 2>&1; then
    kdialog --title "$TITLE" --yes-label "$NOW_LABEL" --no-label "$CANCEL_LABEL" \
        --warningyesno "$TEXT" >/dev/null 2>&1 &
    dpid=$!
    i=0
    while [ "$i" -lt "$SECS" ]; do
        kill -0 "$dpid" 2>/dev/null || break
        sleep 1
        i=$((i + 1))
    done
    if kill -0 "$dpid" 2>/dev/null; then
        kill "$dpid" 2>/dev/null
        wait "$dpid" 2>/dev/null
        exit 0
    fi
    wait "$dpid"
    rc=$?
    [ "$rc" -eq 0 ] && say_now
    too_fast && no_window
    say_cancel
fi

no_window

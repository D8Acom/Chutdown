// Regenerates the bundled finished-chime:   node media/make-chime.js
//
// The chime ships as a wav (media/chime.wav) rather than borrowing one from
// C:\Windows\Media or /System/Library/Sounds, so a fresh install sounds the same on both
// platforms - which means this repo has to CONTAIN a sound, and this is where it comes
// from. Everything about it is here in numbers, so "a bit softer", "one note lower" or
// "let it ring longer" is an edit and a re-run, not a hunt for a new sample.
//
// What it is: one note, low and short - a soft wooden knock, struck and gone inside a
// second, with just enough ring after the strike to sound like something was hit rather
// than clicked. Short enough to carry across a room without being anything to sit through.
// What makes it recognisable is not a tune but the TIMBRE: a struck bar, not a beep. That
// comes from three things:
//
//   PARTIALS   a real bar rings at more than its note. The overtones here are slightly
//              sharp of exact multiples (2.01, 3.02...) - exact multiples sound like an
//              organ, and the small stretch is what reads as "struck metal or wood".
//   DECAY      each partial fades at its OWN rate, the high ones fastest, so the sound
//              darkens as it dies away instead of just getting quieter. That is the
//              single biggest difference between a chime and a beep.
//   ATTACK     6 ms of ramp. Straight to full amplitude is a tick; anything much slower
//              is a swell, and stops sounding struck.
//
// Mono, 44.1 kHz, 16-bit - the format Media.SoundPlayer (Windows) and afplay (macOS)
// both take without a codec.

const fs = require('fs');
const path = require('path');

const RATE = 44100;

// Auditioning a different pitch is the one edit you make over and over, so it is also an
// argument:  node media/make-chime.js 220 try.wav  writes a 220 Hz version somewhere else
// to listen to, and leaves the bundled chime alone. With no arguments it rewrites
// media/chime.wav from the numbers below, which is the real job.
const HZ = Number(process.argv[2]) || 0;
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, 'chime.wav');

// 144 Hz - a D below the bass clef, a low wooden tom rather than a bell. Two octaves under
// where this started, and the trade is real: small laptop speakers roll off below roughly
// 200 Hz, so on those the fundamental is felt more than heard and it is the 2nd and 3rd
// harmonics (288 / 432 Hz) that carry the note - which is why they are loud in the mix
// below, and why the sub-octave partial that used to sit under the fundamental is gone (at
// 72 Hz it was inaudible on anything but headphones, and only muddied the strike).
// On headphones or a desk speaker it is a proper thud. Raise it to ~220 if a laptop
// speaker is the only thing that will ever play it.
//
// `at` is the strike time; `ring` scales every partial's
// decay together, so it is the one number for "how long this hangs about" - 0.44 is a
// knock, 0.7 lets it ring, 1.0 is a bell. A second note here
// (`{ hz: 987.77, at: 0.09, gain: 0.9, ring: 0.44 }`, a fifth up) turns the ping into a
// two-note figure, if you ever want one.
const NOTES = [
    { hz: 144.00, at: 0.00, gain: 1.00, ring: 0.44 }
];

// ratio (slightly stretched), how loud, how fast it dies.
//
// The mix is what makes it a THUD rather than a bell: the fundamental carries the body,
// the two overtones above it carry the note on speakers too small to reproduce 144 Hz,
// and everything higher is gone within a tenth of a second - so the brightness is all in
// the strike, and what is left ringing after it is wood, not metal. Stretching those
// upper decays out towards the fundamental's turns it back into a glockenspiel; that is
// the one knob that decides which instrument this is.
const PARTIALS = [
    { ratio: 1.00, amp: 1.00, decay: 0.55 },
    { ratio: 2.01, amp: 0.55, decay: 0.28 },
    { ratio: 3.02, amp: 0.26, decay: 0.16 },
    { ratio: 4.15, amp: 0.09, decay: 0.09 },
    { ratio: 5.43, amp: 0.03, decay: 0.05 }
];

const ATTACK = 0.006;   // seconds - shorter clicks, longer swells (a thud is not a tick)
const LENGTH = 0.70;    // seconds, including the tail nobody consciously hears
const PEAK = 0.62;      // normalised to this, so it is a chime and not an alarm

// A pitch given on the command line moves every note by the same ratio, so a two-note
// figure stays the same figure - it is transposed, not flattened onto one note.
if (HZ) { const shift = HZ / NOTES[0].hz; for (const note of NOTES) note.hz *= shift; }

const n = Math.round(RATE * LENGTH);
const buf = new Float64Array(n);

for (const note of NOTES) {
    const start = Math.round(note.at * RATE);
    for (let i = start; i < n; i++) {
        const t = (i - start) / RATE;
        // The strike itself, then the ring: every partial on its own decay curve.
        const env = t < ATTACK ? t / ATTACK : 1;
        let v = 0;
        for (const p of PARTIALS)
            v += p.amp * Math.exp(-t / (p.decay * note.ring)) * Math.sin(2 * Math.PI * note.hz * p.ratio * t);
        buf[i] += note.gain * env * v;
    }
}

// Normalise, then fade the last 30 ms to nothing: the tail is inaudible by then, but a
// buffer that ends mid-cycle ends on a click, and a click is the one thing you WILL hear.
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
const scale = peak > 0 ? PEAK / peak : 0;
const fade = Math.round(0.03 * RATE);

const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
    let v = buf[i] * scale;
    if (i > n - fade) v *= (n - i) / fade;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
}

// Canonical 44-byte PCM header.
const head = Buffer.alloc(44);
head.write('RIFF', 0);
head.writeUInt32LE(36 + data.length, 4);
head.write('WAVE', 8);
head.write('fmt ', 12);
head.writeUInt32LE(16, 16);          // PCM chunk size
head.writeUInt16LE(1, 20);           // format: PCM
head.writeUInt16LE(1, 22);           // channels: mono
head.writeUInt32LE(RATE, 24);
head.writeUInt32LE(RATE * 2, 28);    // byte rate
head.writeUInt16LE(2, 32);           // block align
head.writeUInt16LE(16, 34);          // bits
head.write('data', 36);
head.writeUInt32LE(data.length, 40);

fs.writeFileSync(OUT, Buffer.concat([head, data]));
console.log('wrote ' + OUT + '  (' + LENGTH.toFixed(2) + 's, ' + (head.length + data.length) + ' bytes)');

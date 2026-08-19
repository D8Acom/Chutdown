// Builds media/chutdown.ttf - the O / F / S / H launch-button letters as a four-glyph
// icon font, so the STATUS BAR can wear the same marks as the editor title bar.
// A status bar item has no iconPath: its text takes plain text and $(icon) ids, so an
// SVG cannot go there and a contributed icon font is the only way to draw the same
// letter twice. The geometry below is copied from media/letter-*.svg (16x16 viewBox,
// 2-wide round-capped strokes) - edit both, or the two buttons drift apart.
// No dependencies, like make-icon.js: the strokes are outlined by hand and the
// TrueType tables written byte by byte. Re-run with `node media/make-font.js`.
const fs = require('fs');
const path = require('path');

// The 16x16 SVG box maps onto a 1000-unit em with the icon crossing the baseline
// (850 up, 150 down), which is how icon fonts sit level with the text beside them.
const UPM = 1000, ASC = 850, DESC = -150;
const SCALE = UPM / 16;
const HALF = 1;          // half of the SVGs' stroke-width: 2
const CAP = 8;           // points per round cap (half circle)
const ARC = 48;          // points around the O
const BEZ = 16;          // samples per cubic in the S

// The letters, in slot order - O F S H, at U+E001.. in the private use area.
// Each is a list of centrelines in SVG coordinates: `line` for a straight run,
// `curve` for a chain of cubics, `ring` for the O.
const LETTERS = [
    { name: 'o', char: 0xE001, parts: [{ ring: [8, 8, 5.2] }] },
    { name: 'f', char: 0xE002, parts: [
        { line: [[5, 13.2], [5, 3.8], [11.2, 3.8]] },
        { line: [[5, 8], [10, 8]] }
    ] },
    { name: 's', char: 0xE003, parts: [{ curve: [
        [11.3, 4.3], [10.6, 3.2], [9.4, 2.7], [8, 2.7],
        [6.3, 2.7], [5, 3.6], [5, 5.1],
        [5, 8.1], [11, 7], [11, 10.3],
        [11, 12], [9.7, 13.3], [8, 13.3],
        [6.6, 13.3], [5.4, 12.7], [4.7, 11.6]
    ] }] },
    { name: 'h', char: 0xE004, parts: [
        { line: [[4.8, 2.8], [4.8, 13.2]] },
        { line: [[11.2, 2.8], [11.2, 13.2]] },
        { line: [[4.8, 8], [11.2, 8]] }
    ] }
];

// ------------------------------------------------------------------ outlines
//
// Everything is filled with the nonzero rule, so overlapping pieces wound the SAME
// way simply union: a corner needs no mitre maths, just two round-capped segments
// laid over each other. That is why each straight run below is emitted per segment
// rather than offset as a polyline - the caps ARE the joins.

const norm = (dx, dy) => { const d = Math.hypot(dx, dy) || 1; return [dx / d, dy / d]; };

/// Half-circle from angle a0 to a0+span around (cx, cy), first point included.
function cap(cx, cy, a0, span, steps) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
        const a = a0 + span * (i / steps);
        out.push([cx + HALF * Math.cos(a), cy + HALF * Math.sin(a)]);
    }
    return out;
}

/// One round-capped segment as a closed contour: up one side, round the far end,
/// back down the other, round the near end.
function stadium(a, b) {
    const [ux, uy] = norm(b[0] - a[0], b[1] - a[1]);
    const [nx, ny] = [-uy, ux];
    const angN = Math.atan2(ny, nx);
    return [
        [a[0] + nx * HALF, a[1] + ny * HALF],
        ...cap(b[0], b[1], angN, -Math.PI, CAP),
        ...cap(a[0], a[1], angN - Math.PI, -Math.PI, CAP)
    ];
}

/// A smooth open curve is offset properly instead - the S has no corners, so both
/// sides stay clear of each other and one contour holds the whole letter.
function ribbon(pts) {
    const n = pts.length - 1;
    const normals = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n, i + 1)];
        const [ux, uy] = norm(b[0] - a[0], b[1] - a[1]);
        return [-uy, ux];
    });
    const side = (s) => pts.map((p, i) => [p[0] + normals[i][0] * HALF * s, p[1] + normals[i][1] * HALF * s]);
    const left = side(1), right = side(-1);
    const angAt = (i, s) => Math.atan2(normals[i][1] * s, normals[i][0] * s);
    return [
        ...left,
        ...cap(pts[n][0], pts[n][1], angAt(n, 1), -Math.PI, CAP).slice(1),
        ...right.reverse(),
        ...cap(pts[0][0], pts[0][1], angAt(0, -1), -Math.PI, CAP).slice(1)
    ];
}

function circle(cx, cy, r, steps) {
    const out = [];
    for (let i = 0; i < steps; i++) {
        const a = 2 * Math.PI * (i / steps);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
}

function flattenCubics(pts) {
    const out = [pts[0]];
    for (let i = 0; i + 3 < pts.length; i += 3) {
        const [p0, p1, p2, p3] = pts.slice(i, i + 4);
        for (let s = 1; s <= BEZ; s++) {
            const t = s / BEZ, m = 1 - t;
            out.push([
                m * m * m * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t * t * t * p3[0],
                m * m * m * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t * t * t * p3[1]
            ]);
        }
    }
    return out;
}

/// SVG box -> font units: y flips, so a contour's direction flips with it. The
/// rasterizer only needs fills and holes to disagree, but the convention is fills
/// clockwise, and a font that follows it renders the same everywhere.
function toFont(contour, clockwise) {
    const pts = contour.map(([x, y]) => [Math.round(x * SCALE), Math.round(ASC - y * SCALE)]);
    const out = [];
    for (const p of pts) {                          // drop points a rounding apart
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    if (out.length > 1) {
        const f = out[0], l = out[out.length - 1];
        if (f[0] === l[0] && f[1] === l[1]) out.pop();
    }
    let area = 0;
    for (let i = 0; i < out.length; i++) {
        const [x0, y0] = out[i], [x1, y1] = out[(i + 1) % out.length];
        area += x0 * y1 - x1 * y0;
    }
    if ((area < 0) !== !!clockwise) out.reverse();
    return out;
}

function outline(letter) {
    const contours = [];
    for (const part of letter.parts) {
        if (part.ring) {
            const [cx, cy, r] = part.ring;
            contours.push(toFont(circle(cx, cy, r + HALF, ARC), true));
            contours.push(toFont(circle(cx, cy, r - HALF, ARC), false));   // the counter
        } else if (part.curve) {
            contours.push(toFont(ribbon(flattenCubics(part.curve)), true));
        } else {
            const p = part.line;
            for (let i = 0; i + 1 < p.length; i++) contours.push(toFont(stadium(p[i], p[i + 1]), true));
        }
    }
    return contours;
}

// ------------------------------------------------------------------ TrueType
const u8 = (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

/// One glyph's `glyf` entry. Every point is on-curve and every delta two bytes: the
/// outlines are already flattened to straight runs, so the compact forms would save
/// a few hundred bytes and cost the only thing that matters here, being obviously
/// correct.
function glyf(contours) {
    const pts = [].concat(...contours);
    if (!pts.length) return Buffer.alloc(0);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const head = [i16(contours.length), i16(Math.min(...xs)), i16(Math.min(...ys)),
                  i16(Math.max(...xs)), i16(Math.max(...ys))];
    let end = -1;
    for (const c of contours) { end += c.length; head.push(u16(end)); }
    head.push(u16(0));                                   // no instructions
    for (let i = 0; i < pts.length; i++) head.push(u8(0x01));    // on-curve, 2-byte deltas
    let px = 0, py = 0;
    for (const [x] of pts) { head.push(i16(x - px)); px = x; }
    for (const [, y] of pts) { head.push(i16(y - py)); py = y; }
    return pad4(Buffer.concat(head));
}

const glyphs = [[]].concat(LETTERS.map(outline));        // glyph 0 is .notdef, empty
const glyfParts = glyphs.map(glyf);
const glyfTable = Buffer.concat(glyfParts);
const locaOffsets = [];
let at = 0;
for (const g of glyfParts) { locaOffsets.push(at); at += g.length; }
locaOffsets.push(at);
const loca = Buffer.concat(locaOffsets.map(u32));        // long format (head below)

const nGlyphs = glyphs.length;
const allPts = [].concat(...glyphs.map((cs) => [].concat(...cs)));
const box = {
    xMin: Math.min(...allPts.map((p) => p[0])), yMin: Math.min(...allPts.map((p) => p[1])),
    xMax: Math.max(...allPts.map((p) => p[0])), yMax: Math.max(...allPts.map((p) => p[1]))
};

const head = Buffer.concat([
    u32(0x00010000), u32(0x00010000), u32(0),             // version, revision, checksum adj
    u32(0x5F0F3CF5), u16(3), u16(UPM),
    // A fixed date, so re-running this writes a byte-identical font.
    u32(0), u32(0xD1D1B300), u32(0), u32(0xD1D1B300),
    i16(box.xMin), i16(box.yMin), i16(box.xMax), i16(box.yMax),
    u16(0), u16(8), i16(2), i16(1), i16(0)                // style, lowestPPEM, dir, long loca
]);

const hhea = Buffer.concat([
    u32(0x00010000), i16(ASC), i16(DESC), i16(0), u16(UPM),
    i16(box.xMin), i16(UPM - box.xMax), i16(box.xMax),
    i16(1), i16(0), i16(0), i16(0), i16(0), i16(0), i16(0), i16(0), u16(nGlyphs)
]);

const maxp = Buffer.concat([
    u32(0x00010000), u16(nGlyphs),
    u16(Math.max(...glyphs.map((cs) => cs.reduce((n, c) => n + c.length, 0)))),
    u16(Math.max(...glyphs.map((cs) => cs.length))),
    u16(0), u16(0), u16(2), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0), u16(0)
]);

const hmtx = Buffer.concat(glyphs.map(() => Buffer.concat([u16(UPM), i16(0)])));

// cmap format 4, one run of private-use codepoints plus the required 0xFFFF tail,
// listed under both the Windows and the Unicode platform - the same subtable twice,
// because which one a host looks at is not ours to predict.
const first = LETTERS[0].char, last = LETTERS[LETTERS.length - 1].char;
const seg4 = Buffer.concat([
    u16(4), u16(32), u16(0), u16(4), u16(4), u16(1), u16(0),
    u16(last), u16(0xFFFF), u16(0),
    u16(first), u16(0xFFFF),
    u16(1 - first), u16(1),                  // idDelta wraps: glyph 1 is the first letter
    u16(0), u16(0)
]);
const CMAP_HEAD = 4 + 2 * 8;                             // version, count, two records
const cmap = Buffer.concat([
    u16(0), u16(2),
    u16(3), u16(1), u32(CMAP_HEAD), u16(0), u16(3), u32(CMAP_HEAD),
    seg4
]);

const NAMES = ['chutdown', 'Regular', 'chutdown-letters', 'chutdown', 'Version 1.0', 'chutdown'];
const nameRecs = [], nameData = [];
let nameAt = 0;
NAMES.forEach((s, i) => {
    const buf = Buffer.from(s, 'utf16le').swap16();
    nameRecs.push(Buffer.concat([u16(3), u16(1), u16(0x409), u16(i + 1), u16(buf.length), u16(nameAt)]));
    nameData.push(buf);
    nameAt += buf.length;
});
const name = Buffer.concat([u16(0), u16(NAMES.length), u16(6 + NAMES.length * 12),
    ...nameRecs, ...nameData]);

const post = Buffer.concat([u32(0x00030000), u32(0), i16(0), i16(0), u32(0),
    u32(0), u32(0), u32(0), u32(0)]);

const os2 = Buffer.concat([
    u16(4), i16(UPM), u16(400), u16(5), u16(0),
    i16(650), i16(650), i16(0), i16(0), i16(650), i16(650), i16(0), i16(0),
    i16(500), i16(250), i16(0),
    Buffer.alloc(10),                                    // panose: unclassified
    u32(0), u32(0), u32(0), u32(0),                      // no standard unicode range
    Buffer.from('NONE', 'ascii'),
    u16(0x40), u16(first), u16(last),
    i16(ASC), i16(DESC), i16(0), u16(ASC), u16(-DESC),
    u32(0), u32(0),
    i16(500), i16(700), u16(0), u16(0), u16(1)
]);

const tables = [['OS/2', os2], ['cmap', cmap], ['glyf', glyfTable], ['head', head],
    ['hhea', hhea], ['hmtx', hmtx], ['loca', loca], ['maxp', maxp], ['name', name],
    ['post', post]].sort((a, b) => (a[0] < b[0] ? -1 : 1));

function checksum(buf) {
    const b = pad4(buf);
    let sum = 0;
    for (let i = 0; i < b.length; i += 4) sum = (sum + b.readUInt32BE(i)) >>> 0;
    return sum;
}

const n = tables.length;
const maxPow = Math.pow(2, Math.floor(Math.log2(n)));
const dirLen = 12 + n * 16;
let offset = dirLen;
const dir = [Buffer.concat([u32(0x00010000), u16(n), u16(maxPow * 16),
    u16(Math.log2(maxPow)), u16(n * 16 - maxPow * 16)])];
const body = [];
for (const [tag, buf] of tables) {
    dir.push(Buffer.concat([Buffer.from(tag, 'ascii'), u32(checksum(buf)), u32(offset), u32(buf.length)]));
    body.push(pad4(buf));
    offset += pad4(buf).length;
}
const font = Buffer.concat([...dir, ...body]);
// head.checkSumAdjustment: 0xB1B0AFBA minus the checksum of the whole file with that
// field still zero, which is where it is right now.
const headOff = dirLen + tables.slice(0, tables.findIndex((t) => t[0] === 'head'))
    .reduce((s, t) => s + pad4(t[1]).length, 0);
font.writeUInt32BE((0xB1B0AFBA - checksum(font)) >>> 0, headOff + 8);

const out = path.join(__dirname, 'chutdown.ttf');
fs.writeFileSync(out, font);
console.log('wrote ' + out + ' - ' + font.length + ' bytes, ' + nGlyphs + ' glyphs (' +
    LETTERS.map((l) => l.name.toUpperCase() + ' U+' + l.char.toString(16).toUpperCase()).join(', ') + ')');

// Renders media/chutdown-logo.svg to media/icon.png (256x256) for the Marketplace,
// which rejects SVG. No dependencies: the logo is two round-capped strokes, so
// it is drawn from its own geometry (4x4 supersampled) and deflated by hand.
// Re-run with `node media/make-icon.js` after editing media/chutdown-logo.svg.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SIZE = 256, SS = 4;                       // output px, samples per axis
const CX = 128, CY = 128, R = 74, HALF = 12;    // ring centre, radius, half stroke
const A0 = 50 * Math.PI / 180;                  // arc runs clockwise from 50deg...
const A1 = 310 * Math.PI / 180;                 // ...to 310deg, gap facing right
const CAPS = [[175.57, 184.69], [175.57, 71.31], [128, 36], [128, 110]];
const NOTCH = [106, 24, 150, 80];               // mask rect: bar crosses the ring
const BAR_X = 128, BAR_Y0 = 36, BAR_Y1 = 110;
const GRAD = { x1: 40, y1: 24, x2: 216, y2: 232 };
const STOPS = [[0, [0x7d, 0xd3, 0xfc]], [0.5, [0x38, 0xbd, 0xf8]], [1, [0x4f, 0x46, 0xe5]]];

const inNotch = (x, y) => x >= NOTCH[0] && x <= NOTCH[2] && y >= NOTCH[1] && y <= NOTCH[3];

function covered(x, y) {
  // the power bar (with its two round caps) is drawn over the notched ring
  if (Math.abs(x - BAR_X) <= HALF && y >= BAR_Y0 && y <= BAR_Y1) return true;
  for (const [cx, cy] of CAPS.slice(2)) if (Math.hypot(x - cx, y - cy) <= HALF) return true;
  if (inNotch(x, y)) return false;
  for (const [cx, cy] of CAPS.slice(0, 2)) if (Math.hypot(x - cx, y - cy) <= HALF) return true;
  const d = Math.hypot(x - CX, y - CY);
  if (Math.abs(d - R) > HALF) return false;
  let a = Math.atan2(y - CY, x - CX);
  if (a < 0) a += 2 * Math.PI;
  return a >= A0 && a <= A1;
}

function gradient(x, y) {
  const dx = GRAD.x2 - GRAD.x1, dy = GRAD.y2 - GRAD.y1;
  let t = ((x - GRAD.x1) * dx + (y - GRAD.y1) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  let i = 1;
  while (i < STOPS.length - 1 && t > STOPS[i][0]) i++;
  const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return c0.map((c, k) => Math.round(c + (c1[k] - c) * f));
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
for (let py = 0; py < SIZE; py++) {
  raw[p++] = 0;                                  // filter: none
  for (let px = 0; px < SIZE; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++)
      if (covered(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hits++;
    const [r, g, b] = gradient(px + 0.5, py + 0.5);
    raw[p++] = r; raw[p++] = g; raw[p++] = b;
    raw[p++] = Math.round(255 * hits / (SS * SS));
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) : crc32(body));
  return Buffer.concat([len, body, crc]);
};
function crc32(buf) {                            // node < 20.12 has no zlib.crc32
  let c, t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const byte of buf) crc = t[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;                        // 8-bit, RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote ' + out + ' (' + png.length + ' bytes)');

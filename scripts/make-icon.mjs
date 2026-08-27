/**
 * Generates resources/icon.png (512x512) — a minimal "BPMN-ish" app icon
 * drawn programmatically (pure Node, zero dependencies).
 *
 *   npm run icon
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SIZE = 512;
const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

const BG = [31, 182, 255, 255];        // #1fb6ff
const FG = [255, 255, 255, 255];       // white

function set(x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function inRoundedRect(x, y, cx, cy, w, h, r) {
  const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

function inRing(x, y, cx, cy, rOuter, stroke, filled = false) {
  const d2 = (x - cx) ** 2 + (y - cy) ** 2;
  const ro = rOuter;
  const ri = filled ? 0 : rOuter - stroke;
  return d2 <= ro * ro && d2 >= ri * ri;
}

// --- canvas background: rounded square --------------------------------------
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inRoundedRect(x, y, SIZE / 2, SIZE / 2, SIZE - 8, SIZE - 8, 90)) {
      set(x, y, BG);
    }
  }
}

// --- BPMN-ish glyph: start event / task / end event ---------------------------
const cy = 256;

// start event: ring (open circle)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (inRing(x, y, 140, cy, 48, 16)) set(x, y, FG);
    // end event: thick ring
    if (inRing(x, y, 370, cy, 48, 24)) set(x, y, FG);
    // task: rounded rect
    if (inRoundedRect(x, y, 256, cy, 112, 78, 16)) set(x, y, FG);
  }
}

// connectors
for (let x = 0; x < SIZE; x++) {
  for (let y = cy - 5; y <= cy + 5; y++) {
    if (x >= 192 && x <= 198) set(x, y, FG);
    if (x >= 314 && x <= 320) set(x, y, FG);
  }
}

// --- encode PNG ----------------------------------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA

// raw scanlines with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4).forEach((v, i) => {
    raw[rowStart + 1 + i] = v;
  });
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'icon.png');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
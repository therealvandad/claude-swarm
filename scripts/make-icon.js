// Generates every icon the app needs, with no image libraries:
//   assets/icon.ico            Windows window, tray and exe (16..256 px, 32-bit BMP entries)
//   assets/icon.png            512 px, Linux window icon and the source for mac/linux packages
//   assets/tray.png            32 px colour, Linux tray
//   assets/trayTemplate.png    16 px, and @2x 32 px: black + alpha "template" image for the macOS menu bar
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "assets");
const BG = [0xd9, 0x77, 0x57];   // terracotta
const DOT = [0xff, 0xf7, 0xf0];  // off-white

// ---- drawing: a disc with three dots (the swarm mark) ------------------------------------------
function render(size, { template = false } = {}) {
  const ss = 4; // supersampling
  const px = new Uint8Array(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size / 2 - 0.5;
  const dotR = size * 0.11;
  const dots = [[cx, cy - size * 0.19], [cx - size * 0.19, cy + size * 0.13], [cx + size * 0.19, cy + size * 0.13]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0, dotCover = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const fx = x + (sx + 0.5) / ss, fy = y + (sy + 0.5) / ss;
        if (Math.hypot(fx - cx, fy - cy) <= r) {
          cover++;
          for (const [dx, dy] of dots) if (Math.hypot(fx - dx, fy - dy) <= dotR) { dotCover++; break; }
        }
      }
      const a = cover / (ss * ss);
      const t = cover ? dotCover / cover : 0;
      const i = (y * size + x) * 4;
      if (template) { // black silhouette, dots punched out: macOS tints it for light/dark menu bars
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = Math.round(a * (1 - t) * 255);
      } else {        // RGBA
        px[i + 0] = Math.round(BG[0] * (1 - t) + DOT[0] * t);
        px[i + 1] = Math.round(BG[1] * (1 - t) + DOT[1] * t);
        px[i + 2] = Math.round(BG[2] * (1 - t) + DOT[2] * t);
        px[i + 3] = Math.round(a * 255);
      }
    }
  }
  return px;
}

// ---- PNG encoder (RGBA, filter 0, zlib) ---------------------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO (BMP entries) --------------------------------------------------------------------------
function bmpEntry(size, px) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up rows, BGRA
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = y * size * 4 + x * 4;
      xor[d] = px[s + 2]; xor[d + 1] = px[s + 1]; xor[d + 2] = px[s]; xor[d + 3] = px[s + 3];
    }
  }
  const and = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, xor, and]);
}
function ico(sizes) {
  const entries = sizes.map((s) => ({ size: s, data: bmpEntry(s, render(s)) }));
  const dir = Buffer.alloc(6); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirEntries = entries.map((e) => {
    const b = Buffer.alloc(16);
    b.writeUInt8(e.size === 256 ? 0 : e.size, 0); b.writeUInt8(e.size === 256 ? 0 : e.size, 1);
    b.writeUInt16LE(1, 4); b.writeUInt16LE(32, 6); b.writeUInt32LE(e.data.length, 8); b.writeUInt32LE(offset, 12);
    offset += e.data.length;
    return b;
  });
  return Buffer.concat([dir, ...dirEntries, ...entries.map((e) => e.data)]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256]));
fs.writeFileSync(path.join(OUT, "icon.png"), png(512, render(512)));
fs.writeFileSync(path.join(OUT, "tray.png"), png(32, render(32)));
fs.writeFileSync(path.join(OUT, "trayTemplate.png"), png(16, render(16, { template: true })));
fs.writeFileSync(path.join(OUT, "trayTemplate@2x.png"), png(32, render(32, { template: true })));
console.log("wrote icon.ico, icon.png (512), tray.png (32), trayTemplate.png (16, @2x 32) in", OUT);

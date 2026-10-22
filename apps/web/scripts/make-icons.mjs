// Generate PWA icons without an image library: a rounded dark square with three "member" bars.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/icons");
fs.mkdirSync(outDir, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const bg = [31, 41, 55]; // #1f2937
  const fg = [96, 165, 250]; // #60a5fa
  const white = [243, 244, 246];
  const rows = [];
  const r = size * 0.22;
  const inside = (x, y) => {
    // rounded rect
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const bars = [
    [0.22, 0.30, 0.78, 0.40],
    [0.22, 0.45, 0.62, 0.55],
    [0.22, 0.60, 0.70, 0.70],
  ];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      let px = [0, 0, 0, 0];
      if (inside(x + 0.5, y + 0.5)) {
        px = [...bg, 255];
        const fx = x / size;
        const fy = y / size;
        bars.forEach(([x0, y0, x1, y1], i) => {
          if (fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1) px = [...(i === 0 ? fg : white), 255];
        });
      }
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) fs.writeFileSync(path.join(outDir, `icon-${size}.png`), png(size));
console.log(`icons written to ${outDir}`);

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

// Dependency-free PNG encoder for the extension's simple geometric brand mark.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function distance(x, y, x1, y1, x2, y2) {
  const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
  return Math.hypot(x - x1 - t * (x2 - x1), y - y1 - t * (y2 - y1));
}
function icon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const segments = [[42,29,34,29],[34,29,30,34],[30,34,30,53],[30,53,22,64],[22,64,30,75],[30,75,30,94],[30,94,34,99],[34,99,42,99]];
  const lines = [...segments, ...segments.map(([a,b,c,d]) => [128-a,b,128-c,d]), [65,53,65,88], [65,88,59,94]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let count = 0; let fill = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 128 / size;
      const py = (y + (sy + .5) / 4) * 128 / size;
      const dx = Math.max(24 - px, px - 104, 0);
      const dy = Math.max(24 - py, py - 104, 0);
      if (Math.hypot(dx, dy) <= 22) {
        count++;
        if (lines.some(line => distance(px, py, ...line) < 3.7) || Math.hypot(px - 65, py - 37) < 4) fill++;
      }
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const mix = count ? fill / count : 0;
    [33,121,96].forEach((value, index) => { pixels[offset + index] = Math.round(value * (1 - mix) + 255 * mix); });
    pixels[offset + 3] = Math.round(count / 16 * 255);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const output = resolve(import.meta.dirname, '../extension/icons');
await mkdir(output, { recursive: true });
for (const size of [16,32,48,128]) await writeFile(`${output}/icon-${size}.png`, icon(size));
console.log('Generated extension icons (16, 32, 48, 128).');

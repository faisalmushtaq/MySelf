// Generates solid-colour PWA icons (valid PNGs) without image dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * 3;
      // Centred disc in the BrainPop accent green on the cream canvas.
      const cx = x / size - 0.5;
      const cy = y / size - 0.5;
      const inside = Math.sqrt(cx * cx + cy * cy) < 0.33;
      const [r, g, b] = inside ? rgb : [250, 246, 240];
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("apps/participant/public", { recursive: true });
const accent = [6, 120, 67]; // BrainPop --accent #067843
writeFileSync("apps/participant/public/icon-192.png", png(192, accent));
writeFileSync("apps/participant/public/icon-512.png", png(512, accent));
writeFileSync("apps/participant/public/apple-touch-icon.png", png(180, accent));
console.log("icons written");

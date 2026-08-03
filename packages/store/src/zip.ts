/**
 * A minimal, dependency-free ZIP writer, so a researcher can take the whole
 * BIDS folder away in one click.
 *
 * Stored (uncompressed) entries only. That is a deliberate trade: the format
 * is then small enough to read in one sitting and has no dependency that could
 * go unmaintained under an archive of research data. TSVs compress well, but a
 * study's phenotype folder is measured in megabytes, not gigabytes, and an
 * archive nobody can open in ten years is the expensive failure, not a large one.
 */

export interface ZipEntry {
  path: string;
  content: string;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date/time, as the format has demanded since 1989. */
function dosStamp(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.length += b.length;
  }

  u16(v: number): void {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }

  u32(v: number): void {
    this.bytes(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosStamp(now);
  const body = new ByteWriter();
  const directory: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);
    const offset = body.length;

    body.u32(0x04034b50); // local file header
    body.u16(20); // version needed
    body.u16(0x0800); // flags: UTF-8 names
    body.u16(0); // method: stored
    body.u16(stamp.time);
    body.u16(stamp.date);
    body.u32(crc);
    body.u32(data.length);
    body.u32(data.length);
    body.u16(name.length);
    body.u16(0); // extra field length
    body.bytes(name);
    body.bytes(data);

    directory.push({ name, crc, size: data.length, offset });
  }

  const central = new ByteWriter();
  for (const e of directory) {
    central.u32(0x02014b50); // central directory header
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(stamp.time);
    central.u16(stamp.date);
    central.u32(e.crc);
    central.u32(e.size);
    central.u32(e.size);
    central.u16(e.name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(0); // external attributes
    central.u32(e.offset);
    central.bytes(e.name);
  }

  const out = new ByteWriter();
  out.bytes(body.done());
  const centralBytes = central.done();
  const centralOffset = body.length;
  out.bytes(centralBytes);
  out.u32(0x06054b50); // end of central directory
  out.u16(0);
  out.u16(0);
  out.u16(directory.length);
  out.u16(directory.length);
  out.u32(centralBytes.length);
  out.u32(centralOffset);
  out.u16(0); // comment length
  return out.done();
}

import * as zlib from 'zlib';

/**
 * Minimal zip (de)serialization for small in-memory archives, so the extension needs no runtime
 * dependency (it has none). Writes stored (uncompressed) entries; reads stored and deflated ones.
 * No zip64, encryption or multi-disk support.
 */

export function zip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    // Local file header (30 bytes), then name and data. Unset fields (flags, method 0, times) are 0.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    // Central directory entry (46 bytes), then name.
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(entry, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export function unzip(buf: Buffer): Record<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) {
    throw new Error('Not a zip archive');
  }
  const files: Record<string, Buffer> = {};
  let p = buf.readUInt32LE(end + 16);
  for (let count = buf.readUInt16LE(end + 10); count > 0; count--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('Corrupt zip central directory');
    }
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Sizes come from the central directory; the local header only locates the data.
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) {
      files[name] = data;
    } else if (method === 8) {
      files[name] = zlib.inflateRawSync(data);
    } else {
      throw new Error(`Unsupported zip compression method ${method} for ${name}`);
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}
